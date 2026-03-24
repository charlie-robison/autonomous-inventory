"""Facebook Graph API client for accessing Live video streams."""

import httpx


class FacebookAuth:
    """Authenticate with Facebook Graph API and retrieve live stream URLs."""

    GRAPH_API_BASE = "https://graph.facebook.com/v21.0"

    def __init__(self, access_token: str):
        self.access_token = access_token
        self._client = httpx.AsyncClient(timeout=15.0)

    async def close(self):
        await self._client.aclose()

    async def validate_token(self) -> dict:
        """Verify the access token and return token metadata."""
        resp = await self._client.get(
            f"{self.GRAPH_API_BASE}/debug_token",
            params={
                "input_token": self.access_token,
                "access_token": self.access_token,
            },
        )
        resp.raise_for_status()
        data = resp.json().get("data", {})
        if not data.get("is_valid"):
            raise ValueError("Access token is invalid or expired")
        return data

    async def get_live_videos(self, page_id: str) -> list[dict]:
        """List active live videos for a Facebook Page."""
        resp = await self._client.get(
            f"{self.GRAPH_API_BASE}/{page_id}/live_videos",
            params={
                "access_token": self.access_token,
                "fields": "id,title,status,dash_ingest_url,embed_html",
                "broadcast_status": '["LIVE"]',
            },
        )
        resp.raise_for_status()
        return resp.json().get("data", [])

    async def get_stream_url(self, live_video_id: str) -> str:
        """Return the HLS playback URL for a specific live video."""
        resp = await self._client.get(
            f"{self.GRAPH_API_BASE}/{live_video_id}",
            params={
                "access_token": self.access_token,
                "fields": "dash_ingest_url,embed_html,id,status",
            },
        )
        resp.raise_for_status()
        data = resp.json()

        # Try to extract HLS URL from embed_html
        embed = data.get("embed_html", "")
        if "src=" in embed:
            # Extract URL from src attribute
            start = embed.index('src="') + 5
            end = embed.index('"', start)
            return embed[start:end]

        # Fallback: construct live stream URL from video ID
        return f"https://www.facebook.com/video/playback/hls_live/{live_video_id}/"

    async def get_active_stream_url(self, page_id: str) -> str:
        """Convenience: find the first active live stream and return its URL."""
        videos = await self.get_live_videos(page_id)
        if not videos:
            raise ValueError(f"No active live videos found for page {page_id}")

        live_video = videos[0]
        return await self.get_stream_url(live_video["id"])
