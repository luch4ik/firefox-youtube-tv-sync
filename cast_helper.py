#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import mimetypes
import os
import socket
import threading
import time
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse
from xml.etree import ElementTree as ET

import pychromecast
import requests
from pyytlounge import YtLoungeApi
from pyytlounge.event_listener import EventListener
from pyytlounge.events import NowPlayingEvent, PlaybackStateEvent, DisconnectedEvent
from pychromecast.error import PyChromecastError
from pychromecast.quick_play import quick_play


DEVICE_CACHE_TTL_SECONDS = 15
DISCOVERY_TIMEOUT_SECONDS = 6
CAST_WAIT_TIMEOUT_SECONDS = 12
DLNA_DISCOVERY_TIMEOUT_SECONDS = 2
DLNA_MAX_RESPONSES = 24
SSDP_GROUP = ("239.255.255.250", 1900)
DEFAULT_PORT = 49314
DEFAULT_DEVICE_ENV = "CAST_DEFAULT_DEVICE"
CLIENT_HEADER_NAME = "X-Firefox-Cast-Client"
CLIENT_HEADER_VALUE = "firefox-extension"
MAX_REQUEST_BODY_BYTES = 1024 * 1024


@dataclass(slots=True)
class DeviceInfo:
    id: str
    name: str
    protocol: str
    model_name: str
    manufacturer: str
    host: str
    port: int | None
    location: str = ""
    av_transport_url: str = ""
    raw_id: str = ""
    youtube_screen_id: str = ""


class DeviceDirectory:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cached_at = 0.0
        self._devices: list[DeviceInfo] = []

    def list_devices(self, force_refresh: bool = False) -> list[DeviceInfo]:
        with self._lock:
            expired = (time.time() - self._cached_at) > DEVICE_CACHE_TTL_SECONDS
            if force_refresh or expired or not self._devices:
                self._devices = discover_devices()
                self._cached_at = time.time()
            return list(self._devices)


DEVICE_DIRECTORY = DeviceDirectory()


class LoungeStateListener(EventListener):
    def __init__(self, manager: "YouTubeRemoteManager") -> None:
        super().__init__()
        self._manager = manager

    async def playback_state_changed(self, event: PlaybackStateEvent) -> None:
        self._manager.update_state(
            current_time=event.current_time,
            duration=event.duration,
            playback_state=event.state.name.lower(),
            updated_at=time.time(),
            connected=True,
        )

    async def now_playing_changed(self, event: NowPlayingEvent) -> None:
        self._manager.update_state(
            video_id=event.video_id,
            current_time=event.current_time,
            duration=event.duration,
            playback_state=event.state.name.lower(),
            updated_at=time.time(),
            connected=True,
        )

    async def disconnected(self, event: DisconnectedEvent) -> None:
        self._manager.update_state(
            connected=False,
            playback_state="disconnected",
            updated_at=time.time(),
        )


class YouTubeRemoteManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._api: YtLoungeApi | None = None
        self._subscribe_task: asyncio.Task | None = None
        self._state: dict[str, Any] = {
            "connected": False,
            "device_id": None,
            "device_name": None,
            "video_id": None,
            "current_time": None,
            "duration": None,
            "playback_state": "disconnected",
            "updated_at": 0.0,
        }

    def update_state(self, **updates: Any) -> None:
        with self._lock:
            self._state.update({key: value for key, value in updates.items() if value is not None})

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            status = dict(self._state)
        if (
            status.get("connected")
            and status.get("playback_state") == "playing"
            and isinstance(status.get("current_time"), (int, float))
        ):
            delta = max(0.0, time.time() - float(status.get("updated_at") or 0.0))
            status["estimated_current_time"] = min(
                float(status["current_time"]) + delta,
                float(status.get("duration") or (float(status["current_time"]) + delta)),
            )
        else:
            status["estimated_current_time"] = status.get("current_time")
        return status

    def _ensure_loop(self) -> None:
        with self._lock:
            if self._loop is not None:
                return
            ready = threading.Event()

            def runner() -> None:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                with self._lock:
                    self._loop = loop
                ready.set()
                loop.run_forever()

            thread = threading.Thread(target=runner, name="yt-remote-loop", daemon=True)
            self._thread = thread

        thread.start()
        ready.wait()

    def _run_coro(self, coro: Any) -> Any:
        self._ensure_loop()
        assert self._loop is not None
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=30)

    async def _close_api(self) -> None:
        if self._subscribe_task is not None:
            self._subscribe_task.cancel()
            try:
                await self._subscribe_task
            except BaseException:
                pass
            self._subscribe_task = None
        if self._api is not None:
            if self._api.connected():
                try:
                    await self._api.disconnect()
                except Exception:
                    pass
            await self._api.close()
            self._api = None
        self.update_state(
            connected=False,
            playback_state="disconnected",
            updated_at=time.time(),
        )

    async def _connect_and_play(self, device: DeviceInfo, video_id: str) -> dict[str, Any]:
        if self._api is not None:
            await self._close_api()

        listener = LoungeStateListener(self)
        api = YtLoungeApi("firefox-cast-button", event_listener=listener)
        await api.__aenter__()
        try:
            paired = await api.pair_with_screen_id(device.youtube_screen_id, device.name)
            if not paired:
                raise RuntimeError("Could not pair with the TV YouTube screen.")
            connected = await api.connect()
            if not connected:
                raise RuntimeError("Could not connect to the TV YouTube session.")
            self._api = api
            self._subscribe_task = asyncio.create_task(api.subscribe())
            await api.play_video(video_id)
            await api.get_now_playing()
            self.update_state(
                connected=True,
                device_id=device.id,
                device_name=device.name,
                video_id=video_id,
                playback_state="playing",
                updated_at=time.time(),
            )
            return self.get_status()
        except Exception:
            await api.close()
            raise

    async def _command(
        self,
        command: str,
        current_time: float | None = None,
        video_id: str | None = None,
        volume: int | None = None,
    ) -> dict[str, Any]:
        if self._api is None or not self._api.connected():
            raise ValueError("No active YouTube remote session.")

        if command == "play":
            await self._api.play()
            self.update_state(playback_state="playing", updated_at=time.time())
        elif command == "pause":
            await self._api.pause()
            self.update_state(playback_state="paused", updated_at=time.time())
        elif command == "seek":
            if current_time is None:
                raise ValueError("Seek command requires current_time.")
            await self._api.seek_to(float(current_time))
            self.update_state(current_time=float(current_time), updated_at=time.time())
        elif command == "play_video":
            if not video_id:
                raise ValueError("play_video command requires video_id.")
            await self._api.play_video(video_id)
            await self._api.get_now_playing()
            self.update_state(
                video_id=video_id,
                current_time=0.0,
                playback_state="playing",
                updated_at=time.time(),
            )
        elif command == "set_volume":
            if volume is None:
                raise ValueError("set_volume command requires volume.")
            safe_volume = max(0, min(100, int(volume)))
            await self._api.set_volume(safe_volume)
        elif command == "stop":
            await self._close_api()
            return self.get_status()
        elif command == "refresh":
            await self._api.get_now_playing()
        else:
            raise ValueError(f"Unsupported command: {command}")

        return self.get_status()

    def start(self, device: DeviceInfo, video_id: str) -> dict[str, Any]:
        return self._run_coro(self._connect_and_play(device, video_id))

    def command(
        self,
        command: str,
        current_time: float | None = None,
        video_id: str | None = None,
        volume: int | None = None,
    ) -> dict[str, Any]:
        return self._run_coro(self._command(command, current_time, video_id, volume))


YOUTUBE_REMOTE_MANAGER = YouTubeRemoteManager()


def discover_devices() -> list[DeviceInfo]:
    devices: list[DeviceInfo] = []
    seen_ids: set[str] = set()

    for device in discover_chromecast_devices():
        if device.id not in seen_ids:
            seen_ids.add(device.id)
            devices.append(device)

    for device in discover_dlna_devices():
        if device.id not in seen_ids:
            seen_ids.add(device.id)
            devices.append(device)

    devices.sort(key=lambda device: (device.name.lower(), device.protocol))
    return devices


def discover_chromecast_devices() -> list[DeviceInfo]:
    casts, browser = pychromecast.get_chromecasts(timeout=DISCOVERY_TIMEOUT_SECONDS)
    try:
        devices: list[DeviceInfo] = []
        for cast in casts:
            raw_id = str(cast.uuid)
            devices.append(
                DeviceInfo(
                    id=f"chromecast::{raw_id}",
                    name=cast.name,
                    protocol="chromecast",
                    model_name=cast.model_name or "",
                    manufacturer=cast.cast_info.manufacturer or "",
                    host=cast.host,
                    port=cast.port,
                    raw_id=raw_id,
                )
            )
        return devices
    finally:
        pychromecast.stop_discovery(browser)


def discover_dlna_devices() -> list[DeviceInfo]:
    devices: list[DeviceInfo] = []
    seen_locations: set[str] = set()
    query = "\r\n".join(
        [
            "M-SEARCH * HTTP/1.1",
            f"HOST: {SSDP_GROUP[0]}:{SSDP_GROUP[1]}",
            'MAN: "ssdp:discover"',
            "MX: 1",
            "ST: urn:schemas-upnp-org:device:MediaRenderer:1",
            "",
            "",
        ]
    ).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(DLNA_DISCOVERY_TIMEOUT_SECONDS)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)

    try:
        sock.sendto(query, SSDP_GROUP)
        started_at = time.time()
        while len(seen_locations) < DLNA_MAX_RESPONSES:
            remaining = DLNA_DISCOVERY_TIMEOUT_SECONDS - (time.time() - started_at)
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                packet, _addr = sock.recvfrom(65535)
            except socket.timeout:
                break
            headers = parse_ssdp_headers(packet.decode("utf-8", errors="ignore"))
            location = headers.get("location")
            if not location or location in seen_locations:
                continue
            seen_locations.add(location)
            device = load_dlna_device(location)
            if device is not None:
                devices.append(device)
    finally:
        sock.close()

    return devices


def parse_ssdp_headers(payload: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in payload.split("\r\n"):
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def load_dlna_device(location: str) -> DeviceInfo | None:
    if not is_safe_ssdp_location(location):
        return None

    try:
        response = requests.get(location, timeout=4)
        response.raise_for_status()
    except requests.RequestException:
        return None

    try:
        root = ET.fromstring(response.text)
    except ET.ParseError:
        return None

    device_node = root.find(".//{urn:schemas-upnp-org:device-1-0}device")
    if device_node is None:
        return None

    device_type = device_node.findtext("{urn:schemas-upnp-org:device-1-0}deviceType", default="")
    if "MediaRenderer" not in device_type:
        return None

    av_transport_url = ""
    for service in device_node.findall(".//{urn:schemas-upnp-org:device-1-0}service"):
        service_type = service.findtext("{urn:schemas-upnp-org:device-1-0}serviceType", default="")
        if service_type.endswith("AVTransport:1"):
            control_url = service.findtext("{urn:schemas-upnp-org:device-1-0}controlURL", default="")
            av_transport_url = urljoin(location, control_url)
            break

    if not av_transport_url:
        return None

    friendly_name = device_node.findtext("{urn:schemas-upnp-org:device-1-0}friendlyName", default="DLNA TV")
    manufacturer = device_node.findtext("{urn:schemas-upnp-org:device-1-0}manufacturer", default="")
    model_name = device_node.findtext("{urn:schemas-upnp-org:device-1-0}modelName", default="")
    udn = device_node.findtext("{urn:schemas-upnp-org:device-1-0}UDN", default=location)
    parsed = urlparse(location)
    host = parsed.hostname or ""
    port = parsed.port
    youtube_screen_id = fetch_youtube_screen_id(host)

    return DeviceInfo(
        id=f"dlna::{udn}",
        name=friendly_name,
        protocol="dlna",
        model_name=model_name,
        manufacturer=manufacturer,
        host=host,
        port=port,
        location=location,
        av_transport_url=av_transport_url,
        raw_id=udn,
        youtube_screen_id=youtube_screen_id,
    )


def fetch_youtube_screen_id(host: str, tries: int = 3, retry_delay: float = 0.5) -> str:
    for attempt in range(tries):
        try:
            response = requests.get(f"http://{host}:8080/ws/app/YouTube", timeout=3)
            response.raise_for_status()
            root = ET.fromstring(response.text)
        except (requests.RequestException, ET.ParseError):
            root = None

        if root is not None:
            node = root.find(".//{urn:dial-multiscreen-org:schemas:dial}additionalData/{urn:dial-multiscreen-org:schemas:dial}screenId")
            if node is not None and node.text is not None and node.text.strip():
                return node.text.strip()

        if attempt + 1 < tries:
            time.sleep(retry_delay)

    return ""


def is_safe_ssdp_location(location: str) -> bool:
    parsed = urlparse(location)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False

    try:
        host_ip = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        return False

    if (
        host_ip.is_loopback
        or host_ip.is_link_local
        or host_ip.is_multicast
        or host_ip.is_reserved
        or host_ip.is_unspecified
    ):
        return False

    return host_ip.is_private


def is_loopback_bind_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def infer_content_type(media_url: str, explicit_type: str | None) -> str:
    if explicit_type:
        return explicit_type
    if not media_url:
        return "video/mp4"

    guessed, _ = mimetypes.guess_type(media_url)
    if guessed:
        return guessed

    lower_url = media_url.lower()
    if ".m3u8" in lower_url:
        return "application/x-mpegURL"
    if ".mpd" in lower_url:
        return "application/dash+xml"
    if ".mp4" in lower_url:
        return "video/mp4"
    if ".webm" in lower_url:
        return "video/webm"
    if ".mkv" in lower_url:
        return "video/x-matroska"
    return "video/mp4"


def detect_youtube_target(page_url: str | None, media_url: str | None) -> dict[str, Any] | None:
    for candidate in (page_url, media_url):
        if not candidate:
            continue
        parsed = urlparse(candidate)
        host = parsed.netloc.lower()
        if host.endswith("youtube.com"):
            query = parse_qs(parsed.query)
            video_id = query.get("v", [None])[0]
            playlist_id = query.get("list", [None])[0]
            if video_id:
                data: dict[str, Any] = {"media_id": video_id}
                if playlist_id:
                    data["playlist_id"] = playlist_id
                return data
        if host == "youtu.be":
            video_id = parsed.path.lstrip("/").split("/")[0]
            if video_id:
                return {"media_id": video_id}
    return None


def find_device(device_id: str | None, device_name: str | None) -> DeviceInfo:
    for force_refresh in (False, True):
        devices = DEVICE_DIRECTORY.list_devices(force_refresh=force_refresh)
        if device_id:
            for device in devices:
                if device.id == device_id:
                    return device

        if device_name:
            for device in devices:
                if device.name == device_name:
                    return device

        if not force_refresh:
            continue

    if device_id:
        raise LookupError(f'Device "{device_id}" was not found')
    if device_name:
        raise LookupError(f'Device "{device_name}" was not found')

    raise ValueError("No device selected.")


def find_cast(device_name: str):
    casts, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[device_name],
        discovery_timeout=DISCOVERY_TIMEOUT_SECONDS,
    )
    if not casts:
        pychromecast.stop_discovery(browser)
        raise LookupError(f'Cast device "{device_name}" was not found')
    return casts[0], browser


def dlna_envelope(service_type: str, action: str, inner_xml: str) -> str:
    return (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f'<s:Body><u:{action} xmlns:u="{service_type}">{inner_xml}</u:{action}></s:Body>'
        "</s:Envelope>"
    )


def dlna_request(control_url: str, service_type: str, action: str, inner_xml: str) -> str:
    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPAction": f'"{service_type}#{action}"',
    }
    response = requests.post(
        control_url,
        data=dlna_envelope(service_type, action, inner_xml).encode("utf-8"),
        headers=headers,
        timeout=10,
    )
    response.raise_for_status()
    return response.text


def get_dlna_transport_state(device: DeviceInfo) -> str:
    response = dlna_request(
        device.av_transport_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "GetTransportInfo",
        "<InstanceID>0</InstanceID>",
    )
    root = ET.fromstring(response)
    state = root.findtext(".//CurrentTransportState", default="")
    return state.strip().upper()


def build_dlna_metadata(media_url: str, title: str, content_type: str, poster_url: str | None) -> str:
    parts = [
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
        ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
        ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
        '<item id="0" parentID="0" restricted="0">',
        f"<dc:title>{escape_xml(title)}</dc:title>",
        "<upnp:class>object.item.videoItem</upnp:class>",
    ]
    if poster_url:
        parts.append(f"<upnp:albumArtURI>{escape_xml(poster_url)}</upnp:albumArtURI>")
    parts.extend(
        [
            f'<res protocolInfo="http-get:*:{escape_xml(content_type)}:*">{escape_xml(media_url)}</res>',
            "</item>",
            "</DIDL-Lite>",
        ]
    )
    return "".join(parts)


def play_on_dlna(device: DeviceInfo, payload: dict[str, Any]) -> dict[str, Any]:
    media_url = payload.get("media_url")
    page_url = payload.get("page_url")
    title = payload.get("title") or payload.get("tab_title") or "Firefox video"
    poster_url = payload.get("poster_url")
    content_type = infer_content_type(media_url, payload.get("content_type"))

    youtube_data = detect_youtube_target(page_url, media_url)
    if youtube_data is not None:
        if not device.youtube_screen_id:
            device.youtube_screen_id = fetch_youtube_screen_id(device.host)
        if not device.youtube_screen_id:
            launch_samsung_youtube_app(device.host)
            time.sleep(1)
            device.youtube_screen_id = fetch_youtube_screen_id(device.host)
        if not device.youtube_screen_id:
            raise ValueError(
                'This TV does not expose a YouTube screen target. Direct YouTube handoff is unavailable for this device.'
            )
        return play_youtube_on_samsung(device, youtube_data["media_id"])

    if not media_url:
        raise ValueError("No media URL was found on this page.")
    if media_url.startswith("blob:"):
        raise ValueError(
            "This player uses a blob URL. Samsung TV handoff only works for direct media URLs."
        )
    if not media_url.startswith(("http://", "https://")):
        raise ValueError("Only http(s) media URLs can be played on the Samsung TV.")

    service_type = "urn:schemas-upnp-org:service:AVTransport:1"
    metadata = build_dlna_metadata(media_url, title, content_type, poster_url)
    dlna_request(
        device.av_transport_url,
        service_type,
        "SetAVTransportURI",
        (
            "<InstanceID>0</InstanceID>"
            f"<CurrentURI>{escape_xml(media_url)}</CurrentURI>"
            f"<CurrentURIMetaData>{escape_xml(metadata)}</CurrentURIMetaData>"
        ),
    )
    try:
        dlna_request(
            device.av_transport_url,
            service_type,
            "Play",
            "<InstanceID>0</InstanceID><Speed>1</Speed>",
        )
    except requests.HTTPError as exc:
        response_text = exc.response.text if exc.response is not None else ""
        transport_state = get_dlna_transport_state(device)
        if "Transition not available" not in response_text or transport_state not in {"PLAYING", "TRANSITIONING"}:
            raise
    return {
        "ok": True,
        "message": f'Playing on "{device.name}" via DLNA',
        "device_name": device.name,
        "device_id": device.id,
        "mode": "dlna",
        "media_url": media_url,
    }


def launch_samsung_youtube_app(host: str) -> None:
    requests.post(
        f"http://{host}:8001/api/v2/applications/111299001912",
        timeout=5,
    ).raise_for_status()

def play_youtube_on_samsung(device: DeviceInfo, video_id: str) -> dict[str, Any]:
    launch_samsung_youtube_app(device.host)
    YOUTUBE_REMOTE_MANAGER.start(device, video_id)
    return {
        "ok": True,
        "message": f'Playing YouTube on "{device.name}"',
        "device_name": device.name,
        "device_id": device.id,
        "mode": "youtube",
        "video_id": video_id,
    }


def escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def cast_media(payload: dict[str, Any]) -> dict[str, Any]:
    device_id = payload.get("device_id")
    device_name = payload.get("device_name") or os.getenv(DEFAULT_DEVICE_ENV)
    if not device_id and not device_name:
        raise ValueError(
            f'No device selected. Choose a device in the picker or set {DEFAULT_DEVICE_ENV}.'
        )

    device = find_device(device_id, device_name)
    if device.protocol == "dlna":
        return play_on_dlna(device, payload)

    media_url = payload.get("media_url")
    page_url = payload.get("page_url")
    content_type = payload.get("content_type")
    title = payload.get("title") or payload.get("tab_title") or "Firefox video"
    poster_url = payload.get("poster_url")

    youtube_data = detect_youtube_target(page_url, media_url)
    if youtube_data is None:
        if not media_url:
            raise ValueError("No media URL was found on this page.")
        if media_url.startswith("blob:"):
            raise ValueError(
                "This player uses a blob URL. Cast handoff only works for direct media URLs or YouTube page URLs."
            )
        if not media_url.startswith(("http://", "https://")):
            raise ValueError("Only http(s) media URLs can be cast.")

    cast, browser = find_cast(device.name)
    try:
        cast.wait(timeout=CAST_WAIT_TIMEOUT_SECONDS)

        if youtube_data is not None:
            quick_play(cast, "youtube", youtube_data)
            return {
                "ok": True,
                "message": f'Casting YouTube on "{device.name}"',
                "device_name": device.name,
                "device_id": device.id,
                "mode": "youtube",
            }

        metadata = {
            "metadataType": 0,
            "title": title,
        }
        if page_url:
            metadata["subtitle"] = page_url

        cast.media_controller.play_media(
            media_url,
            infer_content_type(media_url, content_type),
            title=title,
            thumb=poster_url,
            autoplay=True,
            stream_type="BUFFERED",
            metadata=metadata,
        )
        cast.media_controller.block_until_active(CAST_WAIT_TIMEOUT_SECONDS)
        return {
            "ok": True,
            "message": f'Casting on "{device.name}"',
            "device_name": device.name,
            "device_id": device.id,
            "mode": "media",
            "media_url": media_url,
        }
    finally:
        try:
            cast.disconnect(timeout=2)
        finally:
            pychromecast.stop_discovery(browser)


class CastRequestHandler(BaseHTTPRequestHandler):
    directory = DEVICE_DIRECTORY

    def do_GET(self) -> None:  # noqa: N802
        if not self._is_authorized():
            self._write_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Forbidden"})
            return
        if self.path.startswith("/health"):
            self._write_json(HTTPStatus.OK, {"ok": True})
            return
        if self.path.startswith("/devices"):
            force_refresh = "refresh=1" in self.path
            devices = [asdict(device) for device in self.directory.list_devices(force_refresh)]
            self._write_json(HTTPStatus.OK, {"ok": True, "devices": devices})
            return
        if self.path.startswith("/youtube-remote/status"):
            self._write_json(HTTPStatus.OK, {"ok": True, "status": YOUTUBE_REMOTE_MANAGER.get_status()})
            return
        self._write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._is_authorized():
            self._write_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Forbidden"})
            return
        if self.path == "/youtube-remote/command":
            self._handle_youtube_remote_command()
            return
        if self.path != "/cast":
            self._write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 0:
                raise ValueError
            if content_length > MAX_REQUEST_BODY_BYTES:
                self._write_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {"ok": False, "error": "Request body too large"},
                )
                return
            raw_body = self.rfile.read(content_length) if content_length else b"{}"
        except ValueError:
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid JSON body"})
            return

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid JSON body"})
            return

        try:
            response = cast_media(payload)
            self._write_json(HTTPStatus.OK, response)
        except LookupError as exc:
            self._write_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)})
        except (PyChromecastError, TimeoutError, ValueError) as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except Exception as exc:  # pragma: no cover
            print(f"[cast-helper] unexpected error: {exc}")
            self._write_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "Unexpected internal error"},
            )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.FORBIDDEN)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[cast-helper] {self.address_string()} - {format % args}")

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_authorized(self) -> bool:
        return self.headers.get(CLIENT_HEADER_NAME) == CLIENT_HEADER_VALUE

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 0:
                raise ValueError
            if content_length > MAX_REQUEST_BODY_BYTES:
                self._write_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {"ok": False, "error": "Request body too large"},
                )
                return None
            raw_body = self.rfile.read(content_length) if content_length else b"{}"
        except ValueError:
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid JSON body"})
            return None

        try:
            return json.loads(raw_body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid JSON body"})
            return None

    def _handle_youtube_remote_command(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        try:
            status = YOUTUBE_REMOTE_MANAGER.command(
                str(payload.get("command", "")),
                float(payload["current_time"]) if "current_time" in payload else None,
                str(payload["video_id"]) if "video_id" in payload else None,
                int(payload["volume"]) if "volume" in payload else None,
            )
            self._write_json(HTTPStatus.OK, {"ok": True, "status": status})
        except ValueError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except Exception as exc:  # pragma: no cover
            print(f"[cast-helper] unexpected youtube command error: {exc}")
            self._write_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "Unexpected internal error"},
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Local playback helper for the Firefox floating cast button extension."
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Port to bind. Default: {DEFAULT_PORT}")
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="Allow binding to non-loopback interfaces. Unsafe on untrusted networks.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not is_loopback_bind_host(args.host) and not args.allow_network:
        raise SystemExit("Refusing to bind to a non-loopback host without --allow-network")
    server = ThreadingHTTPServer((args.host, args.port), CastRequestHandler)
    print(f"Listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
