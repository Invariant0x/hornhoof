import unittest

from totals import line_total


class TotalTests(unittest.TestCase):
    def test_multiple_items(self) -> None:
        self.assertEqual(line_total(125, 3), 375)

    def test_empty_quantity(self) -> None:
        self.assertEqual(line_total(125, 0), 0)

    def test_negative_price(self) -> None:
        with self.assertRaises(ValueError):
            line_total(-1, 2)

    def test_negative_quantity(self) -> None:
        with self.assertRaises(ValueError):
            line_total(125, -1)
