# Network architecture

[Русская версия](../network.md)

## Production host

The entire application stack runs on the Ubuntu 22.04 VPS at `201.51.12.57`.

| Service | Listener | Access |
|---|---|---|
| SSH | `22/tcp` | key-based administration |
| nginx | `80/tcp`, `443/tcp` | public entry point |
| b24-backend | `127.0.0.1:3000` | VPS-local, through nginx only |
| ERPNext frontend | `127.0.0.1:8080` | VPS-local only |
| ERPNext from backend | `http://frontend:8080` | Docker network `erpnext_frappe_network` only |

The application does not depend on a user's computer, background browser, tunnel, or permanently open session.

## Request flow

1. Bitrix24 opens `https://201.51.12.57.sslip.io/placement/...`.
2. nginx terminates TLS and forwards the request to `127.0.0.1:3000`.
3. The backend serves React or handles `/api/*`.
4. For CRM data, the backend calls `umniydom.bitrix24.ru`.
5. For inventory data, the backend calls `frontend:8080` over the Docker network.

ERPNext must not be exposed to the Internet. Host port `8080` exists only for local diagnostics and server-side scripts.

## DNS and TLS

- Public hostname: `201.51.12.57.sslip.io`.
- nginx configuration: `/etc/nginx/sites-available/b24`.
- Certificate: `/etc/letsencrypt/live/201.51.12.57.sslip.io/`.
- Renewal is handled by `certbot.timer`.

When the domain changes, update all of the following together:

1. `server_name` and certificate paths in nginx;
2. `PUBLIC_BASE_URL` in `/root/erpnext/backend.env`;
3. handler and installation URLs in the Bitrix24 local application;
4. placement bindings by opening the application once as an administrator.

## Logs

```bash
docker logs --tail 100 b24-backend
docker logs --tail 100 erpnext-backend-1
journalctl -u nginx --since "30 minutes ago"
tail -100 /root/sync/core-backup.log
```

Layer-by-layer diagnostics are described in [SOS.md](SOS.md).
