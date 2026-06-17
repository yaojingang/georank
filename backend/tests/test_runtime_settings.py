import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.runtime_settings import (  # noqa: E402
    DEFAULT_HOMEPAGE_RELEASE_ID,
    _build_ai_runtime_config,
    _build_diagnostic_rule_config,
    _build_frontend_module_config,
    _build_homepage_runtime_config,
    _build_solution_template_config,
)


class RuntimeSettingsTests(unittest.TestCase):
    def test_build_ai_runtime_config_prefers_database_values(self):
        config = _build_ai_runtime_config(
            {
                "llm_api_key": "db-llm-key",
                "openai_api_key": "db-openai-key",
                "llm_base_url": "https://proxy.example/v1",
                "llm_model": "gpt-db",
                "llm_fallback_model": "gpt-fallback",
                "codex_api_key": "db-codex-key",
                "codex_base_url": "https://codex.example/v1",
                "codex_model": "gpt-codex",
                "embedding_api_key": "db-embed-key",
                "embedding_base_url": "https://embed.example/v1",
                "embedding_model": "text-embedding-db",
                "embedding_dimensions": "1024",
            }
        )

        self.assertEqual(config["llm_api_key"], "db-llm-key")
        self.assertEqual(config["llm_base_url"], "https://proxy.example/v1")
        self.assertEqual(config["llm_model"], "gpt-db")
        self.assertEqual(config["llm_fallback_model"], "gpt-fallback")
        self.assertEqual(config["codex_api_key"], "db-codex-key")
        self.assertEqual(config["codex_base_url"], "https://codex.example/v1")
        self.assertEqual(config["codex_model"], "gpt-codex")
        self.assertEqual(config["embedding_api_key"], "db-embed-key")
        self.assertEqual(config["embedding_base_url"], "https://embed.example/v1")
        self.assertEqual(config["embedding_model"], "text-embedding-db")
        self.assertEqual(config["embedding_dimensions"], 1024)

    def test_build_ai_runtime_config_does_not_reuse_llm_key_for_embedding(self):
        config = _build_ai_runtime_config({"llm_api_key": "shared-key"})

        self.assertEqual(config["llm_api_key"], "shared-key")
        self.assertEqual(config["embedding_api_key"], "")

    def test_build_ai_runtime_config_falls_back_to_codex_for_llm_backup(self):
        config = _build_ai_runtime_config(
            {
                "llm_api_key": "primary-key",
                "codex_model": "gpt-5.3-codex-spark",
            }
        )

        self.assertEqual(config["llm_fallback_model"], "gpt-5.3-codex-spark")
        self.assertEqual(config["codex_api_key"], "primary-key")

    def test_build_ai_runtime_config_includes_enabled_llm_provider_pool(self):
        config = _build_ai_runtime_config(
            {
                "llm_providers": {
                    "strategy": "round_robin",
                    "providers": [
                        {
                            "id": "deepseek-primary",
                            "name": "DeepSeek 主线路",
                            "base_url": "https://api.deepseek.com",
                            "model": "deepseek-chat",
                            "enabled": True,
                            "priority": 2,
                        },
                        {
                            "id": "disabled",
                            "name": "Disabled",
                            "base_url": "https://disabled.example/v1",
                            "model": "disabled-model",
                            "enabled": False,
                            "priority": 1,
                        },
                    ],
                },
                "llm_provider_keys": {
                    "deepseek-primary": "sk-provider",
                    "disabled": "sk-disabled",
                },
            }
        )

        self.assertEqual(config["llm_provider_strategy"], "round_robin")
        self.assertEqual(len(config["llm_providers"]), 1)
        self.assertEqual(config["llm_providers"][0]["id"], "deepseek-primary")
        self.assertEqual(config["llm_providers"][0]["api_key"], "sk-provider")

    def test_build_diagnostic_rule_config_normalizes_weights(self):
        config = _build_diagnostic_rule_config(
            {"diagnostic_rule_weights": {"schema": 40, "content": 30, "meta": 20, "citation": 10}}
        )

        self.assertEqual(config["weights"]["schema"], 40)
        self.assertEqual(config["weights"]["citation"], 10)
        self.assertEqual(config["total"], 100)
        self.assertAlmostEqual(config["normalized_weights"]["schema"], 0.4)
        self.assertAlmostEqual(config["normalized_weights"]["citation"], 0.1)

    def test_build_diagnostic_rule_config_falls_back_when_total_invalid(self):
        config = _build_diagnostic_rule_config(
            {"diagnostic_rule_weights": {"schema": -1, "content": 0, "meta": 0, "citation": 0}}
        )

        self.assertEqual(config["weights"]["schema"], 30.0)
        self.assertEqual(config["weights"]["content"], 30.0)
        self.assertEqual(config["weights"]["meta"], 20.0)
        self.assertEqual(config["weights"]["citation"], 20.0)

    def test_build_solution_template_config_prefers_database_values(self):
        config = _build_solution_template_config(
            {
                "solution_templates": {
                    "system_prompt": "数据库系统提示词",
                    "response_instruction": "数据库回答指令",
                    "streaming_system_prompt": "数据库流式提示词",
                }
            }
        )

        self.assertEqual(config["system_prompt"], "数据库系统提示词")
        self.assertEqual(config["response_instruction"], "数据库回答指令")
        self.assertEqual(config["streaming_system_prompt"], "数据库流式提示词")

    def test_build_solution_template_config_falls_back_to_defaults(self):
        config = _build_solution_template_config({})

        self.assertIn("AI 问答顾问", config["system_prompt"])
        self.assertIn("回答用户问题", config["response_instruction"])
        self.assertIn("诊断上下文", config["streaming_system_prompt"])

    def test_build_frontend_module_config_defaults_to_all_enabled(self):
        config = _build_frontend_module_config({})

        self.assertEqual(config["default_module"], "companies")
        self.assertGreaterEqual(len(config["modules"]), 8)
        self.assertTrue(all(module["enabled"] for module in config["modules"]))

    def test_build_frontend_module_config_moves_default_to_enabled_module(self):
        config = _build_frontend_module_config(
            {
                "frontend_modules": {
                    "default_module": "companies",
                    "modules": [
                        {"key": "companies", "enabled": False},
                        {"key": "diagnostic", "enabled": False},
                        {"key": "solutions", "enabled": False},
                        {"key": "plans", "enabled": False},
                        {"key": "keywords", "enabled": False},
                        {"key": "tools", "enabled": True},
                        {"key": "experts", "enabled": False},
                        {"key": "tutorial", "enabled": False},
                        {"key": "unknown", "enabled": True},
                    ],
                }
            }
        )

        self.assertEqual(config["default_module"], "tools")
        modules = {module["key"]: module for module in config["modules"]}
        self.assertFalse(modules["companies"]["enabled"])
        self.assertFalse(modules["diagnostic"]["enabled"])
        self.assertTrue(modules["tools"]["enabled"])
        self.assertNotIn("unknown", modules)

    def test_build_homepage_runtime_config_defaults_to_builtin_homepage(self):
        config = _build_homepage_runtime_config({})

        self.assertEqual(config["mode"], "custom")
        self.assertEqual(config["active_release_id"], DEFAULT_HOMEPAGE_RELEASE_ID)
        self.assertEqual(config["company_list_path"], "/companies")

    def test_build_homepage_runtime_config_can_restore_company_homepage(self):
        config = _build_homepage_runtime_config(
            {
                "homepage_runtime": {
                    "mode": "default",
                    "active_release_id": None,
                    "company_list_path": "/companies",
                }
            }
        )

        self.assertEqual(config["mode"], "default")
        self.assertIsNone(config["active_release_id"])


if __name__ == "__main__":
    unittest.main()
