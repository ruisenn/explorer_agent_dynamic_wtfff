import unittest

import httpx

from app import app


class AppRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.lifespan = app.router.lifespan_context(app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:3100",
        )

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)

    async def test_health_and_api_discovery(self) -> None:
        health = await self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertTrue(health.json()["ok"])
        discovery = await self.client.get("/")
        self.assertEqual(discovery.status_code, 200)
        self.assertEqual(discovery.json()["mode"], "api-only")
        self.assertEqual(
            discovery.json()["demo"],
            "/windowsXP-simulation/demo.html",
        )
        self.assertEqual((await self.client.get("/sandbox")).status_code, 404)
        self.assertEqual((await self.client.get("/app.js")).status_code, 404)

    async def test_windows_xp_demo_static_files(self) -> None:
        page = await self.client.get("/windowsXP-simulation/demo.html")
        self.assertEqual(page.status_code, 200)
        self.assertTrue(page.headers["content-type"].startswith("text/html"))
        self.assertIn("<!DOCTYPE html>", page.text)

        wallpaper = await self.client.get("/windowsXP-simulation/img/bliss.jpg")
        self.assertEqual(wallpaper.status_code, 200)
        self.assertEqual(wallpaper.headers["content-type"], "image/jpeg")
        self.assertGreater(len(wallpaper.content), 0)

    async def test_run_requires_json_content_type(self) -> None:
        response = await self.client.post("/api/run", content="{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(response.status_code, 415)

    async def test_run_rejects_large_body(self) -> None:
        response = await self.client.post(
            "/api/run",
            content=b"{" + (b" " * (33 * 1024)),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)

    async def test_run_rejects_untrusted_origin(self) -> None:
        response = await self.client.post(
            "/api/run",
            json={"startUrl": "http://127.0.0.1:3100/target", "goal": "test"},
            headers={"Origin": "https://example.com"},
        )
        self.assertEqual(response.status_code, 403)

    async def test_cors_preflight_for_configured_origin(self) -> None:
        response = await self.client.options(
            "/api/run",
            headers={
                "Origin": "http://127.0.0.1:3100",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "http://127.0.0.1:3100")

    async def test_run_rejects_non_allowlisted_target(self) -> None:
        response = await self.client.post(
            "/api/run",
            json={"startUrl": "https://example.com", "goal": "test"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("not allowed", response.json()["error"])

    async def test_runtime_does_not_serve_unknown_frame(self) -> None:
        self.assertEqual((await self.client.get("/runtime/frame-old.jpg")).status_code, 404)


if __name__ == "__main__":
    unittest.main()
