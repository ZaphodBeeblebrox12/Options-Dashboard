"""Telegram notification sender for Alert System v2.2."""
import requests
import logging
from typing import Optional

logger = logging.getLogger(__name__)

TELEGRAM_API_URL = "https://api.telegram.org/bot{token}/sendMessage"


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
        rule_name = payload.get("rule_name", "Alert")
        index_name = payload.get("index_name", "NIFTY")
        timestamp = payload.get("timestamp", "")
        spot = payload.get("spot")
        atm = payload.get("atm_strike")
        max_ce = payload.get("max_ce_oi_strike")
        max_pe = payload.get("max_pe_oi_strike")
        max_neg_gex = payload.get("max_negative_gex_strike")
        net_gex = payload.get("net_gex")

        # Build message
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

        message_text = "\n".join(lines)

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
