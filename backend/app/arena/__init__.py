"""Darwesh Arena -- the competitive real-estate gamification layer.

Server-authoritative by construction, same as app.verification: every
points/rank/leaderboard/challenge-config collection is unwritable by a
browser (see firestore.rules), so app.arena.arena_ops is the only place
those transitions exist.
"""
