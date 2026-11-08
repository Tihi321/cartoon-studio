# SPDX-License-Identifier: GPL-3.0-or-later
"""Runs every blender/tests/test_*.py with unittest in Blender's own Python:

    blender -b --factory-startup --python-exit-code 1 --python blender/tests/run.py

(`yarn test:blender` does this and fails, not skips, when Blender is missing.) Exit code 1 when a test fails.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

suite = unittest.defaultTestLoader.discover(HERE, pattern="test_*.py")
outcome = unittest.TextTestRunner(verbosity=2).run(suite)
sys.stdout.flush()
sys.exit(0 if outcome.wasSuccessful() else 1)
