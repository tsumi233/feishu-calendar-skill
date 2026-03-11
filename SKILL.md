---
name: feishu-calendar
description: |
  Create and manage Feishu calendar events from chat. Use when the user asks to create, inspect, authorize, or delete a Feishu/Lark calendar event, meeting, or schedule.
---

# Feishu Calendar

Use the bundled script:

- `scripts/feishu-calendar.mjs`

## When To Use

- Create a Feishu calendar event
- Authorize direct write access to the requester's own Feishu primary calendar
- Check whether the app can write to a user's primary calendar
- Delete a test event you just created

## Rules

- For Feishu chats, extract the requesting user's `open_id` from inbound metadata `sender_id` and pass it as `--requester-open-id`.
- Prefer exact ISO timestamps with timezone offsets, for example:
  - `2026-03-12T15:00:00+08:00`
- Confirm title, start, and end before creating an event.
- Before asking for direct write to the requester's own calendar, run the one-time user authorization flow on the Mac running OpenClaw.
- The default local callback is `http://127.0.0.1:18790/feishu-calendar/callback`. Add this exact redirect URI in the Feishu app before running `auth-start`.
- The built-in auth flow requests these user scopes by default: `offline_access`, `calendar:calendar:read`, `calendar:calendar`, `calendar:calendar.event:create`, `calendar:calendar.event:update`, `calendar:calendar.event:delete`.
- If you changed Feishu app permissions, you must run `auth-start` again so the user token is re-issued with the new scopes.
- `create` first tries a saved `user_access_token` for the requester's `open_id`. If that is unavailable or fails, it automatically falls back to the bot's primary calendar and invites the requester as an attendee. Tell the user when this fallback happens.
- Do not invent calendar IDs. Let the script resolve the primary calendar unless the user explicitly gives a `calendar_id`.

## Commands

### Probe Access

```bash
node scripts/feishu-calendar.mjs probe --requester-open-id ou_xxx
```

Returns the bot primary calendar, the requester's tenant-token role, and any saved user authorization status.

### Start User Authorization

```bash
node scripts/feishu-calendar.mjs auth-start \
  --requester-open-id ou_xxx \
  --open-browser true
```

This opens a browser on the same Mac, waits for the local callback, exchanges the code, and stores the user's `user_access_token` locally.

### Check User Authorization

```bash
node scripts/feishu-calendar.mjs auth-status --requester-open-id ou_xxx
```

Returns whether a saved user authorization exists and whether it is still refreshable.

### Create Event

```bash
node scripts/feishu-calendar.mjs create \
  --title "项目评审" \
  --start "2026-03-12T15:00:00+08:00" \
  --end "2026-03-12T16:00:00+08:00" \
  --requester-open-id ou_xxx \
  --description "评审新版本发布计划" \
  --location-name "线上会议"
```

Optional flags:

- `--timezone Asia/Shanghai`
- `--location-address "上海市浦东新区..."`
- `--invite-open-id ou_xxx` (repeatable)
- `--need-notification true|false`
- `--target-open-id ou_xxx` (defaults to requester)

### Delete Event

```bash
node scripts/feishu-calendar.mjs delete \
  --calendar-id feishu.cn_xxx@group.calendar.feishu.cn \
  --event-id 6912345678901234567 \
  --requester-open-id ou_xxx
```

## Output

The script prints JSON only.

Important fields:

- `ok`
- `strategy`
- `calendarId`
- `eventId`
- `requesterCalendarRole`
- `userAuthorization`
- `notes`
