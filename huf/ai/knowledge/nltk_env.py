# Copyright (c) 2025, Huf and contributors
# For license information, please see license.txt

"""Keep LlamaIndex's bundled NLTK data off hardlinked package files.

Some environments install the Python env in a way that hardlinks package
files from a shared cache (e.g. `uv`'s default link mode). `llama_index.core`
bundles NLTK corpora under its own `_static/nltk_cache` and loads them via
`nltk.data`. Newer `nltk` releases ship a hardened `pathsec.open` that refuses
to open any file with `st_nlink > 1`, since an in-root hardlink could
otherwise point at an attacker-controlled inode outside the sandbox root
(CWE-59). That check is legitimate and we don't want to weaken it — but a
benign packaging hardlink then makes every Knowledge Source indexing attempt
fail with `Security Violation [pathsec.open]: refusing multiply-linked file`.

`ensure_writable_nltk_data()` makes indexing environment-agnostic instead of
disabling the check: it copies LlamaIndex's bundled NLTK data (a real
`shutil.copy`, which always creates a fresh inode with `st_nlink == 1`) into a
private, per-site directory the first time it's needed, and points
`nltk.data.path` there first so `nltk.data.load`/`find` resolve the copy
before the original bundled files.
"""

import shutil

import frappe

_DONE = False


def ensure_writable_nltk_data() -> None:
	"""Idempotently make sure NLTK loads data from a non-hardlinked copy.

	Safe to call repeatedly and safe to fail: any error is logged and
	swallowed so a packaging/environment quirk here never blocks Knowledge
	Source indexing outright (the caller falls through to the normal
	LlamaIndex/NLTK error handling if the underlying files turn out to be
	unreadable for some other reason).
	"""
	global _DONE
	if _DONE:
		return

	try:
		import nltk
	except ImportError:
		_DONE = True
		return

	try:
		bundled_root = _find_bundled_nltk_cache()
		if bundled_root is None:
			return

		if not _has_multiply_linked_file(bundled_root):
			# Nothing to work around in this environment.
			return

		private_root = frappe.utils.get_site_path("private", "files", "nltk_data")
		if not _is_populated(private_root, bundled_root):
			shutil.rmtree(private_root, ignore_errors=True)
			shutil.copytree(bundled_root, private_root, copy_function=shutil.copy)

		if private_root not in nltk.data.path:
			nltk.data.path.insert(0, private_root)
	except Exception:
		frappe.log_error(
			title="Knowledge NLTK Data Setup Error",
			message=frappe.get_traceback(),
		)
	finally:
		_DONE = True


def _find_bundled_nltk_cache():
	"""Return the path to `llama_index.core`'s bundled `_static/nltk_cache`, if any."""
	try:
		import llama_index.core as llama_index_core
	except ImportError:
		return None

	import os

	candidate = os.path.join(os.path.dirname(llama_index_core.__file__), "_static", "nltk_cache")
	return candidate if os.path.isdir(candidate) else None


def _has_multiply_linked_file(root) -> bool:
	"""True if any regular file under `root` has more than one hardlink."""
	import os

	for dirpath, _dirnames, filenames in os.walk(root):
		for filename in filenames:
			try:
				if os.stat(os.path.join(dirpath, filename)).st_nlink > 1:
					return True
			except OSError:
				continue
	return False


def _is_populated(private_root, bundled_root) -> bool:
	"""True if `private_root` already looks like a complete, safe copy."""
	import os

	if not os.path.isdir(private_root):
		return False

	for dirpath, _dirnames, filenames in os.walk(bundled_root):
		rel = os.path.relpath(dirpath, bundled_root)
		for filename in filenames:
			dest = os.path.join(private_root, rel, filename)
			if not os.path.isfile(dest):
				return False
			try:
				if os.stat(dest).st_nlink > 1:
					return False
			except OSError:
				return False
	return True
