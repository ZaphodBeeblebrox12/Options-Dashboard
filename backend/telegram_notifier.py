"""Telegram notification sender for Alert System v2.2."""
import requests
import logging
from typing import Optional

logger = logging.getLogger(__name__)

TELEGRAM_API_URL = "https://api.telegram.org/bot{token}/sendMessage"


def build_telegram_message(payload: dict) -> str:
    """Select the Telegram template by alert tier. Tier 4 has its own dedicated
    formatting; Tier 1/2/3 keep the standard template."""
    if payload.get("instrument_tier") == 4:
        return _format_tier4_message(payload)
    return _format_standard_message(payload)


def resolve_telegram_destination(settings: dict, instrument_tier) -> dict:
    """Pick the Telegram destination for a fired alert. Tier 4 uses its
    dedicated bot/chat when configured (enabled + token + chat_id) and falls
    back to the shared destination otherwise. Tier 1/2/3 always use the
    shared destination."""
    if instrument_tier == 4:
        t4 = (settings.get("tier4") or {}).get("telegram") or {}
        if t4.get("enabled") and t4.get("bot_token") and t4.get("chat_id"):
            return t4
    return settings.get("telegram") or {}


def _format_standard_message(payload: dict) -> str:
    """Standard Tier 1/2/3 Telegram template (unchanged v2.2 layout)."""
    rule_name = payload.get("rule_name", "Alert")
    index_name = payload.get("index_name", "NIFTY")
    timestamp = payload.get("timestamp", "")
    spot = payload.get("spot")
    atm = payload.get("atm_strike")
    max_ce = payload.get("max_ce_oi_strike")
    max_pe = payload.get("max_pe_oi_strike")
    max_neg_gex = payload.get("max_negative_gex_strike")
    net_gex = payload.get("net_gex")

    lines = [
        f"🚨 <b>{index_name} ALERT</b>",
        "",
        f"<b>Rule:</b> {rule_name}",
        f"<b>Time:</b> {timestamp}",
        "",
        f"<b>Spot:</b> {spot:,.2f}" if spot else "<b>Spot:</b> —",
        f"<b>ATM:</b> {atm:,}" if atm else "<b>ATM:</b> —",
        "",
        f"<b>Max CE Wall:</b> {max_ce:,}" if max_ce else "<b>Max CE Wall:</b> —",
        f"<b>Max PE Wall:</b> {max_pe:,}" if max_pe else "<b>Max PE Wall:</b> —",
        f"<b>Neg GEX Wall:</b> {max_neg_gex:,}" if max_neg_gex else "<b>Neg GEX Wall:</b> —",
        f"<b>Net GEX:</b> {net_gex:,.0f}" if net_gex else "<b>Net GEX:</b> —",
    ]
    return "\n".join(lines)


def _format_tier4_message(payload: dict) -> str:
    """Dedicated Tier-4 template: distinct headline, the rule name with the
    engine's TIER 4 prefix stripped (it is implicit in the headline), and
    source attribution for the Angel-fed Greeks layer."""
    rule_name = str(payload.get("rule_name", "Alert")).replace("TIER 4 | ", "")
    index_name = payload.get("index_name", "NIFTY")
    timestamp = payload.get("timestamp", "")
    spot = payload.get("spot")
    atm = payload.get("atm_strike")
    max_ce = payload.get("max_ce_oi_strike")
    max_pe = payload.get("max_pe_oi_strike")
    max_neg_gex = payload.get("max_negative_gex_strike")
    net_gex = payload.get("net_gex")

    lines = [
        f"🔷 <b>TIER 4 ALERT — {index_name}</b>",
        "",
        f"<b>Rule:</b> {rule_name}",
        f"<b>Time:</b> {timestamp}",
        "",
        f"<b>Spot:</b> {spot:,.2f}" if spot else "<b>Spot:</b> —",
        f"<b>ATM:</b> {atm:,}" if atm else "<b>ATM:</b> —",
        "",
        f"<b>Max CE Wall:</b> {max_ce:,}" if max_ce else "<b>Max CE Wall:</b> —",
        f"<b>Max PE Wall:</b> {max_pe:,}" if max_pe else "<b>Max PE Wall:</b> —",
        f"<b>Neg GEX Wall:</b> {max_neg_gex:,}" if max_neg_gex else "<b>Neg GEX Wall:</b> —",
        f"<b>Net GEX:</b> {net_gex:,.0f}" if net_gex else "<b>Net GEX:</b> —",
        "",
        "<i>Tier 4 · Angel One Greeks feed · dedicated Tier-4 routing</i>",
    ]
    return "\n".join(lines)


def send_telegram_alert(
    bot_token: str,
    chat_id: str,
    payload: dict,
) -> bool:
    """Send an alert message to Telegram.

    Args:
        bot_token: Telegram bot token from @BotFather
        chat_id: Target chat ID (group or user)
        payload: AlertTriggerPayload as dict

    Returns:
        True if sent successfully, False otherwise.
    """
    if not bot_token or not chat_id:
        logger.warning("[Telegram] Missing bot_token or chat_id")
        return False

    try:
        message_text = build_telegram_message(payload)

        url = TELEGRAM_API_URL.format(token=bot_token)
        resp = requests.post(
            url,
            json={
                "chat_id": chat_id,
                "text": message_text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("ok"):
            logger.info(f"[Telegram] Alert sent to {chat_id}")
            return True
        else:
            logger.error(f"[Telegram] API error: {data}")
            return False

    except requests.exceptions.RequestException as e:
        logger.error(f"[Telegram] Request failed: {e}")
        return False
    except Exception as e:
        logger.error(f"[Telegram] Unexpected error: {e}")
        return False


def test_telegram_connection(bot_token: str, chat_id: str) -> tuple[bool, str]:
    """Test Telegram connection by sending a test message.

    Returns:
        (success: bool, message: str)
    """
    if not bot_token or not chat_id:
        return False, "Bot token and chat ID are required"

    try:
        url = TELEGRAM_API_URL.format(token=bot_token)
        resp = requests.post(
            url,
            json={
                "chat_id": chat_id,
                "text": "✅ <b>Test Message</b>\n\nYour NIFTY/SENSEX Alert Bot is connected and working!",
                "parse_mode": "HTML",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("ok"):
            return True, "Test message sent successfully"
        return False, f"Telegram API error: {data.get('description', 'Unknown')}"
    except Exception as e:
        return False, str(e)
