# Unit tests for the real Vertex AI Gemini adapter
# (backend/app/mam/providers/gemini.py). The google-genai SDK client
# itself (network calls to Vertex AI) is always mocked here -- these
# tests prove this adapter's OWN logic (request building, response
# parsing, error handling, timeout, Kurdish/Arabic-Indic-digit
# passthrough) is correct, independent of any real credential or
# network access, which this sandbox has neither of. No live provider
# call is made by this file, ever.
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from google.genai import types
from google.genai.errors import APIError

from app.mam.providers import gemini as gemini_module
from app.mam.providers.base import ChatTurn, ModelTier, ToolCallRequest, ToolSpec
from app.mam.providers.gemini import GeminiProvider, _decode_tool_content, _history_to_contents, _tool_spec_to_gemini_tool


def make_provider() -> GeminiProvider:
    return GeminiProvider(project_id="darwesh-group", location="global", model_flash="gemini-3.7-flash", model_pro="gemini-3.1-pro-preview")


def text_response(text: str, finish_reason: types.FinishReason = types.FinishReason.STOP) -> types.GenerateContentResponse:
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=[types.Part.from_text(text=text)]), finish_reason=finish_reason)]
    )


def function_call_response(name: str, args: dict, call_id: str = "call-1") -> types.GenerateContentResponse:
    fc = types.FunctionCall(id=call_id, name=name, args=args)
    return types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=[types.Part(function_call=fc)]), finish_reason=types.FinishReason.STOP)]
    )


# ---- Constructor validation (unchanged behavior from the placeholder) ----

def test_constructor_requires_all_fields():
    with pytest.raises(ValueError):
        GeminiProvider(project_id="", location="global", model_flash="gemini-3.7-flash", model_pro="gemini-3.1-pro-preview")
    with pytest.raises(ValueError):
        GeminiProvider(project_id="darwesh-group", location="", model_flash="gemini-3.7-flash", model_pro="gemini-3.1-pro-preview")


def test_constructor_never_receives_or_stores_a_credential():
    provider = make_provider()
    # No api_key/credential attribute exists anywhere on this adapter --
    # the only way it can authenticate is ADC, resolved by the SDK
    # client itself, never something this class holds or could log.
    assert not hasattr(provider, "_api_key")
    assert not hasattr(provider, "_credentials")


def test_model_for_tier():
    provider = make_provider()
    assert provider._model_for(ModelTier.FAST) == "gemini-3.7-flash"
    assert provider._model_for(ModelTier.REASONING) == "gemini-3.1-pro-preview"


# ---- generate(): normal completion ----

@pytest.mark.asyncio
async def test_normal_completion_returns_text():
    provider = make_provider()
    provider._client.aio.models.generate_content = AsyncMock(return_value=text_response("Here are 2 real listings in Erbil."))

    result = await provider.generate(
        system_instruction="You are MAM.", history=[ChatTurn(role="user", content="villa in Erbil")],
        tools=[], tier=ModelTier.FAST, max_output_tokens=800,
    )

    assert result.text == "Here are 2 real listings in Erbil."
    assert result.tool_calls == []
    assert result.finish_reason == "stop"
    provider._client.aio.models.generate_content.assert_awaited_once()
    _, kwargs = provider._client.aio.models.generate_content.call_args
    assert kwargs["model"] == "gemini-3.7-flash"  # FAST tier


@pytest.mark.asyncio
async def test_reasoning_tier_uses_pro_model():
    provider = make_provider()
    provider._client.aio.models.generate_content = AsyncMock(return_value=text_response("answer"))
    await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.REASONING, max_output_tokens=800)
    _, kwargs = provider._client.aio.models.generate_content.call_args
    assert kwargs["model"] == "gemini-3.1-pro-preview"


# ---- generate(): tool calls ----

@pytest.mark.asyncio
async def test_tool_call_response_is_parsed_into_tool_calls():
    provider = make_provider()
    provider._client.aio.models.generate_content = AsyncMock(
        return_value=function_call_response("search_properties", {"city": "Erbil"}, call_id="abc123")
    )
    result = await provider.generate(
        system_instruction="x", history=[ChatTurn(role="user", content="villa in Erbil")],
        tools=[ToolSpec(name="search_properties", description="d", parameters_schema={"type": "object"})],
        tier=ModelTier.FAST, max_output_tokens=800,
    )
    assert result.text is None
    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_name == "search_properties"
    assert result.tool_calls[0].arguments == {"city": "Erbil"}
    assert result.tool_calls[0].call_id == "abc123"


@pytest.mark.asyncio
async def test_tool_call_without_id_gets_a_synthetic_call_id():
    provider = make_provider()
    fc = types.FunctionCall(id=None, name="search_properties", args={})
    response = types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=[types.Part(function_call=fc)]), finish_reason=types.FinishReason.STOP)]
    )
    provider._client.aio.models.generate_content = AsyncMock(return_value=response)
    result = await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)
    assert result.tool_calls[0].call_id  # non-empty, synthesized


# ---- generate(): malformed / empty response ----

@pytest.mark.asyncio
async def test_empty_candidates_raises():
    provider = make_provider()
    provider._client.aio.models.generate_content = AsyncMock(return_value=types.GenerateContentResponse(candidates=[]))
    with pytest.raises(RuntimeError, match="no candidates"):
        await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)


@pytest.mark.asyncio
async def test_candidate_with_no_parts_raises_empty_response():
    provider = make_provider()
    response = types.GenerateContentResponse(
        candidates=[types.Candidate(content=types.Content(role="model", parts=[]), finish_reason=types.FinishReason.SAFETY)]
    )
    provider._client.aio.models.generate_content = AsyncMock(return_value=response)
    with pytest.raises(RuntimeError, match="empty response"):
        await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)


@pytest.mark.asyncio
async def test_malformed_response_missing_content_raises_not_crashes():
    provider = make_provider()
    # A candidate whose `content` is entirely absent (malformed relative
    # to a normal response) must be handled via getattr-with-default, not
    # an AttributeError escaping to the caller.
    response = types.GenerateContentResponse(candidates=[types.Candidate(content=None, finish_reason=types.FinishReason.OTHER)])
    provider._client.aio.models.generate_content = AsyncMock(return_value=response)
    with pytest.raises(RuntimeError, match="empty response"):
        await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)


# ---- generate(): provider exceptions never leak raw details ----

@pytest.mark.asyncio
async def test_api_error_is_converted_to_safe_runtime_error():
    provider = make_provider()
    provider._client.aio.models.generate_content = AsyncMock(
        side_effect=APIError(code=503, response_json={"error": {"message": "internal quota detail nobody outside Google should see"}})
    )
    with pytest.raises(RuntimeError) as exc_info:
        await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)
    assert "internal quota detail" not in str(exc_info.value)
    assert str(exc_info.value) == "Gemini API call failed"


# ---- generate(): timeout ----

@pytest.mark.asyncio
async def test_timeout_raises_timeout_error_not_hang(monkeypatch):
    provider = make_provider()
    monkeypatch.setattr(gemini_module, "_REQUEST_TIMEOUT_SECONDS", 0.05)

    async def _never_returns(**kwargs):
        await asyncio.sleep(5)
        return text_response("too late")

    provider._client.aio.models.generate_content = _never_returns
    with pytest.raises(TimeoutError, match="did not respond within"):
        await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)


# ---- generate(): cancellation propagates, is never swallowed ----

@pytest.mark.asyncio
async def test_cancellation_propagates_not_swallowed():
    provider = make_provider()

    async def _cancel(**kwargs):
        raise asyncio.CancelledError()

    provider._client.aio.models.generate_content = _cancel
    with pytest.raises(asyncio.CancelledError):
        await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)


# ---- Kurdish / Arabic-Indic digit passthrough (no normalization here --
# that's intent_resolver.py's job; this adapter must treat text as
# opaque and never mutate it) ----

def test_kurdish_text_passes_through_history_conversion_unmodified():
    kurdish = "خانووی گونجاو لە هەولێر بۆ فرۆشتن، نرخی ٣٥٠,٠٠٠ دۆلار"
    contents = _history_to_contents([ChatTurn(role="user", content=kurdish)])
    assert contents[0].parts[0].text == kurdish


def test_arabic_indic_digits_pass_through_unmodified():
    text_with_digits = "٠١٢٣٤٥٦٧٨٩ و ۰۱۲۳۴۵۶۷۸۹"
    contents = _history_to_contents([ChatTurn(role="user", content=text_with_digits)])
    assert contents[0].parts[0].text == text_with_digits


@pytest.mark.asyncio
async def test_kurdish_response_text_passes_through_unmodified():
    provider = make_provider()
    kurdish_reply = "٢ ئەنجام دۆزرایەوە: خانووێک لە هەولێر"
    provider._client.aio.models.generate_content = AsyncMock(return_value=text_response(kurdish_reply))
    result = await provider.generate(system_instruction="x", history=[], tools=[], tier=ModelTier.FAST, max_output_tokens=800)
    assert result.text == kurdish_reply


# ---- _history_to_contents: role mapping ----

def test_history_to_contents_maps_user_and_assistant_roles():
    history = [ChatTurn(role="user", content="hi"), ChatTurn(role="assistant", content="hello")]
    contents = _history_to_contents(history)
    assert [c.role for c in contents] == ["user", "model"]
    assert contents[0].parts[0].text == "hi"
    assert contents[1].parts[0].text == "hello"


def test_history_to_contents_assistant_with_tool_calls_becomes_function_call_parts():
    turn = ChatTurn(
        role="assistant", content="",
        tool_calls=(ToolCallRequest(call_id="c1", tool_name="search_properties", arguments={"city": "Erbil"}),),
    )
    contents = _history_to_contents([turn])
    assert contents[0].role == "model"
    assert contents[0].parts[0].function_call.name == "search_properties"
    assert contents[0].parts[0].function_call.args == {"city": "Erbil"}


def test_history_to_contents_tool_role_becomes_function_response():
    turn = ChatTurn(role="tool", content='{"count": 1, "results": []}', tool_name="search_properties", tool_call_id="c1")
    contents = _history_to_contents([turn])
    assert contents[0].role == "tool"
    assert contents[0].parts[0].function_response.name == "search_properties"
    assert contents[0].parts[0].function_response.response == {"count": 1, "results": []}


def test_decode_tool_content_handles_valid_and_invalid_json():
    assert _decode_tool_content('{"a": 1}') == {"a": 1}
    assert _decode_tool_content("") == {}
    assert _decode_tool_content("not json") == {"result": "not json"}
    assert _decode_tool_content("[1, 2, 3]") == {"result": [1, 2, 3]}


# ---- _tool_spec_to_gemini_tool ----

def test_tool_spec_translation():
    specs = [ToolSpec(name="search_properties", description="Search listings", parameters_schema={"type": "object", "properties": {}})]
    tool = _tool_spec_to_gemini_tool(specs)
    assert len(tool.function_declarations) == 1
    assert tool.function_declarations[0].name == "search_properties"
    assert tool.function_declarations[0].description == "Search listings"
