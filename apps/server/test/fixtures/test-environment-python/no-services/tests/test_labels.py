import unittest

from labels import label


class LabelTests(unittest.TestCase):
    def test_title(self) -> None:
        self.assertEqual(label("Blue Basket"), "blue-basket")

    def test_repeated_whitespace(self) -> None:
        self.assertEqual(label("  A   B  "), "a-b")
