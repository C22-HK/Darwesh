"""Darwesh verification, referrals, rewards and secure archival.

Server-authoritative by construction: firestore.rules make every
collection in this package unwritable by a browser, so these modules are
the only place the transitions exist.
"""
