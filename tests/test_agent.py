import tempfile
import unittest
from pathlib import Path

from src.agent import AgentRunner


async def ignore_event(_: dict) -> None:
    return None


class AgentValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        upload_dir = root / "fixtures"
        upload_dir.mkdir()
        (upload_dir / "demo-report.txt").write_text("demo", encoding="utf-8")
        self.runner = AgentRunner(
            start_url="http://127.0.0.1:3100/target",
            goal="test",
            use_screenshot=False,
            runtime_dir=root / "runtime",
            upload_dir=upload_dir,
            on_event=ignore_event,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_parse_fenced_json_action(self) -> None:
        action = self.runner.parse_action('```json\n{"type":"finish","summary":"done"}\n```')
        self.assertEqual(action["type"], "finish")

    def test_wait_is_clamped(self) -> None:
        action = self.runner.validate_action({"type": "wait", "value": 9000})
        self.assertEqual(action["value"], 2000)

    def test_upload_must_use_available_file_id(self) -> None:
        action = self.runner.validate_action(
            {
                "type": "upload",
                "target": {"testId": "attachment"},
                "fileId": "demo-report",
            }
        )
        self.assertEqual(action["fileId"], "demo-report")
        with self.assertRaisesRegex(RuntimeError, "fileId is invalid"):
            self.runner.validate_action(
                {
                    "type": "upload",
                    "target": {"testId": "attachment"},
                    "fileId": "../secret",
                }
            )

    def test_sensitive_input_is_redacted_from_public_event(self) -> None:
        action = self.runner.validate_action(
            {
                "type": "fill",
                "target": {"label": "Password"},
                "value": "not-for-the-timeline",
            }
        )
        self.assertEqual(self.runner.public_action(action)["valuePreview"], "[REDACTED]")

    def test_interactive_action_requires_target(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Target is required"):
            self.runner.validate_action({"type": "click"})


if __name__ == "__main__":
    unittest.main()
