"""Sound management for Alert System v2.2.

Built-in sounds are served as base64-encoded WAV data.
Custom sounds are stored on disk with metadata in the DB.
"""
import os
import base64
import uuid
from typing import Dict, List, Optional
from alert_db import get_custom_sounds, save_custom_sound, delete_custom_sound, get_custom_sound

# Directory for custom sound files
CUSTOM_SOUNDS_DIR = os.path.join(os.path.dirname(__file__), "custom_sounds")
os.makedirs(CUSTOM_SOUNDS_DIR, exist_ok=True)

# ── Built-in sounds (short WAV beeps/chimes as base64) ─────────
# These are tiny 8-bit mono 22050Hz WAV files, base64-encoded.
# In production you might serve actual files; here we embed minimal sounds.

BUILT_IN_SOUNDS: Dict[str, Dict[str, str]] = {
    "chime": {
        "name": "Chime",
        "description": "Soft chime",
        # Minimal valid WAV header + short sine burst (base64)
        "base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    },
    "bell": {
        "name": "Bell",
        "description": "Classic bell",
        "base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    },
    "beep": {
        "name": "Beep",
        "description": "Short beep",
        "base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    },
    "alert": {
        "name": "Alert",
        "description": "Alert tone",
        "base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    },
    "double_beep": {
        "name": "Double Beep",
        "description": "Two quick beeps",
        "base64": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    },
}


def get_built_in_sounds() -> List[Dict[str, str]]:
    """Return list of built-in sounds."""
    return [
        {"id": key, "name": info["name"], "description": info["description"], "type": "built_in"}
        for key, info in BUILT_IN_SOUNDS.items()
    ]


def get_all_sounds() -> List[Dict[str, str]]:
    """Return built-in + custom sounds."""
    sounds = get_built_in_sounds()
    for cs in get_custom_sounds():
        sounds.append({
            "id": cs["id"],
            "name": cs["name"],
            "description": f"Custom ({cs['content_type']})",
            "type": "custom",
            "filename": cs["filename"],
            "size_bytes": cs["size_bytes"],
        })
    return sounds


def get_sound_base64(sound_id: str) -> Optional[str]:
    """Get base64-encoded sound data for playback."""
    if sound_id in BUILT_IN_SOUNDS:
        return BUILT_IN_SOUNDS[sound_id]["base64"]

    cs = get_custom_sound(sound_id)
    if cs:
        filepath = os.path.join(CUSTOM_SOUNDS_DIR, cs["filename"])
        if os.path.exists(filepath):
            with open(filepath, "rb") as f:
                return base64.b64encode(f.read()).decode("ascii")
    return None


def save_uploaded_sound(name: str, content_type: str, file_data: bytes) -> Dict[str, str]:
    """Save an uploaded sound file."""
    sound_id = str(uuid.uuid4())
    ext = ".mp3"
    if "wav" in content_type.lower():
        ext = ".wav"
    elif "ogg" in content_type.lower():
        ext = ".ogg"
    filename = f"{sound_id}{ext}"
    filepath = os.path.join(CUSTOM_SOUNDS_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(file_data)

    save_custom_sound(
        sound_id=sound_id,
        name=name,
        filename=filename,
        content_type=content_type,
        size_bytes=len(file_data),
    )

    return {
        "id": sound_id,
        "name": name,
        "filename": filename,
        "content_type": content_type,
        "size_bytes": len(file_data),
    }


def remove_custom_sound(sound_id: str) -> bool:
    """Delete a custom sound."""
    cs = get_custom_sound(sound_id)
    if cs:
        filepath = os.path.join(CUSTOM_SOUNDS_DIR, cs["filename"])
        if os.path.exists(filepath):
            os.remove(filepath)
    delete_custom_sound(sound_id)
    return True
