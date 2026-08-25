import { useEffect, useRef, useState } from 'react';

interface WSMessage {
  type: string;
  data: any;
}

export function useWebSocket(url: string, onError?: (msg: string) => void) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let shouldReconnect = true;

    const cleanup = () => {
      shouldReconnect = false;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        const oldWs = ws;
        ws = null;
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        try { oldWs.close(1000, 'cleanup'); } catch {}
      }
    };

    const connect = () => {
      if (!shouldReconnect) return;
      if (ws?.readyState === WebSocket.OPEN) return;

      console.log('[WS] Connecting...');
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log('[WS] Connected');
        setConnected(true);
        attempts = 0;
        heartbeat = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;
          setLastMessage(msg);
        } catch (e) {
          console.error('[WS] Parse error:', e);
        }
      };

      ws.onclose = (event) => {
        console.log(`[WS] Disconnected (code=${event.code})`);
        setConnected(false);
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        if (!shouldReconnect) return;
        if (event.code === 1000) return; // intentional close

        const delay = Math.min(1000 * (2 ** attempts), 30000);
        attempts += 1;
        console.log(`[WS] Reconnecting in ${delay}ms...`);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        console.error('[WS] Connection error');
        if (onError) onError('WebSocket connection error');
      };
    };

    connect();

    return () => {
      console.log('[WS] Cleanup (unmount)');
      cleanup();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const send = (data: any) => {
    // We need to access the current ws, but it's scoped inside useEffect.
    // This is a limitation of the simple approach.
    console.warn('[WS] send() not implemented in simple hook');
  };

  return { connected, lastMessage, send };
}
