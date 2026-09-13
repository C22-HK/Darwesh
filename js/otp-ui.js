// Shared UI helpers for the email-OTP flows (signup.html,
// reset-password.html): an accessible 6-digit code input and email
// masking for display. Kept framework-free and dependency-free since
// this project has no build step.

// Wires up 6 <input data-otp-index="0".."5"> elements already present
// in the DOM (each page owns its own markup/styling) into a single
// accessible OTP entry widget: numeric-only, auto-advances on digit
// entry, backspace steps back through empty boxes, arrow-key
// navigation, and paste of a full 6-digit code fills every box at
// once. onComplete fires with the 6-digit string as soon as all boxes
// hold a digit -- callers still read getValue() themselves before
// submitting (onComplete is a convenience for auto-submit UX, not the
// source of truth).
export function wireOtpInputs(container, { onComplete } = {}) {
  const inputs = [...container.querySelectorAll('[data-otp-index]')].sort(
    (a, b) => Number(a.dataset.otpIndex) - Number(b.dataset.otpIndex)
  );

  function currentValue() {
    return inputs.map((i) => i.value).join('');
  }

  function checkComplete() {
    const value = currentValue();
    if (value.length === 6 && /^\d{6}$/.test(value) && onComplete) onComplete(value);
  }

  inputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && idx < inputs.length - 1) inputs[idx + 1].focus();
      checkComplete();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        inputs[idx - 1].focus();
        inputs[idx - 1].value = '';
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        inputs[idx - 1].focus();
      } else if (e.key === 'ArrowRight' && idx < inputs.length - 1) {
        inputs[idx + 1].focus();
      }
    });
    input.addEventListener('paste', (e) => {
      const clipboard = e.clipboardData || window.clipboardData;
      const pasted = clipboard.getData('text').replace(/\D/g, '');
      if (!pasted) return;
      e.preventDefault();
      pasted
        .slice(0, inputs.length)
        .split('')
        .forEach((digit, i) => {
          inputs[i].value = digit;
        });
      const nextIdx = Math.min(pasted.length, inputs.length - 1);
      inputs[nextIdx].focus();
      checkComplete();
    });
  });

  return {
    getValue: currentValue,
    clear() {
      inputs.forEach((i) => (i.value = ''));
      inputs[0].focus();
    },
    focus() {
      inputs[0].focus();
    }
  };
}

// mohammed@example.com -> m******d@example.com. Keeps the first and
// last character of the local part (so the owner can still recognize
// their own address) and masks everything in between; a very short
// local part (<=2 chars) masks everything after the first character
// instead of producing something nonsensical like "*@example.com".
export function maskEmail(email) {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) {
    return local[0] + '*'.repeat(Math.max(1, local.length - 1)) + domain;
  }
  return local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] + domain;
}
