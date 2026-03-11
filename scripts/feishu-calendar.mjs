#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const FEISHU_DEFAULT_DOMAIN = "feishu";
const FEISHU_DEFAULT_ACCOUNT = "default";
const FEISHU_DEFAULT_TZ = "Asia/Shanghai";
const FEISHU_DEFAULT_AUTH_HOST = "127.0.0.1";
const FEISHU_DEFAULT_AUTH_PORT = 18790;
const FEISHU_DEFAULT_AUTH_PATH = "/feishu-calendar/callback";
const FEISHU_DEFAULT_AUTH_SCOPES = [
  "offline_access",
  "calendar:calendar:read",
  "calendar:calendar",
  "calendar:calendar.event:create",
  "calendar:calendar.event:update",
  "calendar:calendar.event:delete",
];
const TOKEN_REFRESH_SKEW_MS = 120 * 1000;
const STATE_ROOT = path.join(
  os.homedir(),
  ".openclaw",
  "skills",
  "feishu-calendar",
  "state",
);

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      pushFlag(flags, key, "true");
      continue;
    }
    pushFlag(flags, key, next);
    i += 1;
  }

  return { positional, flags };
}

function pushFlag(flags, key, value) {
  const existing = flags.get(key);
  if (existing === undefined) {
    flags.set(key, value);
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  flags.set(key, [existing, value]);
}

function getFlag(flags, key, fallback = undefined) {
  const value = flags.get(key);
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return value ?? fallback;
}

function getFlagList(flags, key) {
  const value = flags.get(key);
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function requireFlag(flags, key) {
  const value = getFlag(flags, key);
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseInteger(raw, fallback, label) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid integer for ${label}: ${raw}`);
  }
  return value;
}

function resolveApiBase(domain) {
  if (!domain || domain === FEISHU_DEFAULT_DOMAIN) return "https://open.feishu.cn";
  if (domain === "lark") return "https://open.larksuite.com";
  return domain.replace(/\/+$/, "");
}

function resolveAccountsBase(domain) {
  if (!domain || domain === FEISHU_DEFAULT_DOMAIN) return "https://accounts.feishu.cn";
  if (domain === "lark") return "https://accounts.larksuite.com";
  return domain.replace(/\/+$/, "");
}

function readOpenClawConfig() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

function readFeishuAccount(accountId) {
  const config = readOpenClawConfig();
  const feishu = config.channels?.feishu;
  const account = feishu?.accounts?.[accountId];
  if (!account?.appId || !account?.appSecret) {
    throw new Error(`Feishu account "${accountId}" is not configured in ~/.openclaw/openclaw.json`);
  }
  return {
    appId: account.appId,
    appSecret: account.appSecret,
    domain: account.domain || feishu?.domain || FEISHU_DEFAULT_DOMAIN,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from Feishu API (${response.status}): ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${json.msg || text}`);
  }
  if (typeof json.code === "number" && json.code !== 0) {
    throw new Error(`Feishu API error ${json.code}: ${json.msg || "unknown error"}`);
  }
  return json;
}

async function getTenantAccessToken(account) {
  const url = `${resolveApiBase(account.domain)}/open-apis/auth/v3/tenant_access_token/internal`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: account.appId,
      app_secret: account.appSecret,
    }),
  });
  const token = json.tenant_access_token;
  if (!token) {
    throw new Error("Feishu tenant_access_token missing from auth response");
  }
  return token;
}

async function getPrimaryCalendar(token, domain) {
  const url = `${resolveApiBase(domain)}/open-apis/calendar/v4/calendars/primary`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const calendars = json.data?.calendars;
  if (!Array.isArray(calendars) || calendars.length === 0 || !calendars[0]?.calendar?.calendar_id) {
    throw new Error("Primary calendar not found for current identity");
  }
  return calendars[0];
}

async function getPrimaryCalendarsForOpenIds(token, domain, openIds) {
  const uniqueOpenIds = unique(openIds);
  if (uniqueOpenIds.length === 0) return [];
  const url = `${resolveApiBase(domain)}/open-apis/calendar/v4/calendars/primarys?user_id_type=open_id`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      user_ids: uniqueOpenIds,
    }),
  });
  return json.data?.calendars || [];
}

function buildEventTime(input, timezone) {
  const value = String(input).trim();
  if (!value) {
    throw new Error("Event time cannot be empty");
  }
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid datetime: ${input}`);
  }
  return {
    timestamp: String(Math.floor(dt.getTime() / 1000)),
    timezone,
  };
}

async function createEvent(token, domain, payload) {
  const url = `${resolveApiBase(domain)}/open-apis/calendar/v4/calendars/${encodeURIComponent(payload.calendarId)}/events`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      summary: payload.title,
      description: payload.description,
      need_notification: payload.needNotification,
      start_time: payload.startTime,
      end_time: payload.endTime,
      visibility: payload.visibility,
      attendee_ability: payload.attendeeAbility,
      free_busy_status: payload.freeBusyStatus,
      location: payload.location,
      reminders: payload.reminders,
      source: "openclaw-feishu-calendar-skill",
    }),
  });
  const event = json.data?.event;
  if (!event?.event_id) {
    throw new Error("Feishu event_id missing from create response");
  }
  return event;
}

async function addAttendees(token, domain, payload) {
  const attendees = unique(payload.openIds).map((openId) => ({
    type: "user",
    user_id: openId,
  }));
  if (attendees.length === 0) {
    return [];
  }
  const url = `${resolveApiBase(domain)}/open-apis/calendar/v4/calendars/${encodeURIComponent(payload.calendarId)}/events/${encodeURIComponent(payload.eventId)}/attendees?user_id_type=open_id`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      attendees,
      need_notification: payload.needNotification,
    }),
  });
  return json.data?.attendees || [];
}

async function deleteEvent(token, domain, payload) {
  const url = `${resolveApiBase(domain)}/open-apis/calendar/v4/calendars/${encodeURIComponent(payload.calendarId)}/events/${encodeURIComponent(payload.eventId)}`;
  await fetchJson(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
}

function normalizePrimaryEntry(entry) {
  const calendar = entry?.calendar || {};
  return {
    userId: entry?.user_id || null,
    calendarId: calendar.calendar_id || null,
    summary: calendar.summary || null,
    role: calendar.role || null,
    type: calendar.type || null,
    permissions: calendar.permissions || null,
  };
}

function roleCanWrite(role) {
  return role === "owner" || role === "writer";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonFileSecure(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getUserTokenPath(accountId, openId) {
  return path.join(STATE_ROOT, "users", accountId, `${openId}.json`);
}

function toIsoTime(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toMsFromSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Date.now() + value * 1000;
}

function sanitizeUserAuthRecord(record) {
  if (!record) return null;
  return {
    accountId: record.accountId || null,
    openId: record.openId || null,
    userId: record.userId || null,
    name: record.name || null,
    expiresAt: record.expiresAt || null,
    refreshExpiresAt: record.refreshExpiresAt || null,
    updatedAt: record.updatedAt || null,
    scope: record.scope || null,
  };
}

function buildUserAuthRecord(accountId, authData, userInfo, existing = null) {
  const expiresAtMs = toMsFromSeconds(authData.expires_in);
  const refreshExpiresAtMs = toMsFromSeconds(authData.refresh_expires_in);
  return {
    accountId,
    openId: authData.open_id || userInfo?.open_id || existing?.openId || null,
    userId: authData.user_id || userInfo?.user_id || existing?.userId || null,
    name: authData.name || userInfo?.name || existing?.name || null,
    accessToken: authData.access_token || existing?.accessToken || null,
    refreshToken: authData.refresh_token || existing?.refreshToken || null,
    expiresAt: expiresAtMs ? toIsoTime(expiresAtMs) : existing?.expiresAt || null,
    refreshExpiresAt: refreshExpiresAtMs
      ? toIsoTime(refreshExpiresAtMs)
      : existing?.refreshExpiresAt || null,
    scope: authData.scope || existing?.scope || null,
    updatedAt: new Date().toISOString(),
  };
}

function accessTokenUsable(record) {
  if (!record?.accessToken || !record?.expiresAt) return false;
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now();
}

function refreshTokenUsable(record) {
  if (!record?.refreshToken || !record?.refreshExpiresAt) return Boolean(record?.refreshToken);
  const refreshExpiresAtMs = Date.parse(record.refreshExpiresAt);
  if (!Number.isFinite(refreshExpiresAtMs)) return true;
  return refreshExpiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now();
}

function buildUserAuthStatus(record, error = null) {
  return {
    stored: Boolean(record),
    authorized: Boolean(record?.accessToken || record?.refreshToken),
    openId: record?.openId || null,
    userId: record?.userId || null,
    name: record?.name || null,
    expiresAt: record?.expiresAt || null,
    refreshExpiresAt: record?.refreshExpiresAt || null,
    accessValid: accessTokenUsable(record),
    refreshUsable: refreshTokenUsable(record),
    error: error || null,
  };
}

function loadStoredUserAuth(accountId, openId) {
  return readJsonFile(getUserTokenPath(accountId, openId));
}

function saveStoredUserAuth(record) {
  if (!record?.accountId || !record?.openId) {
    throw new Error("Cannot persist user auth without accountId and openId");
  }
  writeJsonFileSecure(getUserTokenPath(record.accountId, record.openId), record);
}

async function getUserInfo(token, domain) {
  const url = `${resolveApiBase(domain)}/open-apis/authen/v1/user_info`;
  const json = await fetchJson(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  return json.data || {};
}

async function exchangeUserAccessToken(account, code) {
  const url = `${resolveApiBase(account.domain)}/open-apis/authen/v1/access_token`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: account.appId,
      app_secret: account.appSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!json.data?.access_token) {
    throw new Error("Feishu user access_token missing from exchange response");
  }
  return json.data;
}

async function refreshUserAccessToken(account, refreshToken) {
  const url = `${resolveApiBase(account.domain)}/open-apis/authen/v1/refresh_access_token`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: account.appId,
      app_secret: account.appSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!json.data?.access_token) {
    throw new Error("Feishu user access_token missing from refresh response");
  }
  return json.data;
}

async function getFreshStoredUserAuth(accountId, account, openId) {
  const existing = loadStoredUserAuth(accountId, openId);
  if (!existing) {
    return null;
  }
  if (accessTokenUsable(existing)) {
    return existing;
  }
  if (!refreshTokenUsable(existing)) {
    throw new Error("Stored Feishu user authorization has expired and needs to be re-authorized");
  }

  const refreshed = await refreshUserAccessToken(account, existing.refreshToken);
  const userInfo = await getUserInfo(refreshed.access_token, account.domain);
  const record = buildUserAuthRecord(accountId, refreshed, userInfo, existing);
  if (record.openId !== openId) {
    throw new Error(`Refreshed user auth belongs to ${record.openId}, expected ${openId}`);
  }
  saveStoredUserAuth(record);
  return record;
}

function buildAuthorizeUrl(account, options) {
  const base = `${resolveAccountsBase(account.domain)}/open-apis/authen/v1/authorize`;
  const url = new URL(base);
  url.searchParams.set("client_id", account.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  const scopes = unique(options.scopes?.length ? options.scopes : FEISHU_DEFAULT_AUTH_SCOPES);
  if (scopes.length > 0) {
    url.searchParams.set("scope", scopes.join(" "));
  }
  return {
    authUrl: url.toString(),
    scopes,
  };
}

function maybeOpenBrowser(url) {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
      return true;
    }
    if (process.platform === "linux") {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

function waitForAuthCallback(options) {
  const redirectUrl = new URL(options.redirectUri);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error(`Timed out waiting for Feishu authorization callback after ${options.timeoutSeconds}s`));
    }, options.timeoutSeconds * 1000);

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", options.redirectUri);
      if (reqUrl.pathname !== redirectUrl.pathname) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const state = reqUrl.searchParams.get("state");
      const error = reqUrl.searchParams.get("error");
      const errorDescription = reqUrl.searchParams.get("error_description");
      const code = reqUrl.searchParams.get("code");

      if (state !== options.expectedState) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Authorization failed", "Invalid state. You can close this tab."));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error("Feishu authorization callback state mismatch"));
        }
        return;
      }

      if (error) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Authorization failed", `${error}${errorDescription ? `: ${errorDescription}` : ""}`));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Feishu authorization failed: ${error}${errorDescription ? ` (${errorDescription})` : ""}`));
        }
        return;
      }

      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Authorization failed", "Missing authorization code. You can close this tab."));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(new Error("Feishu authorization callback missing code"));
        }
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlPage("Authorization complete", "Feishu calendar authorization succeeded. You can close this tab."));
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        resolve({ code });
      }
    });

    server.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    server.listen(options.listenPort, options.listenHost);
  });
}

function buildRedirectUri(flags) {
  const explicit = getFlag(flags, "redirect-uri");
  if (explicit) {
    return explicit;
  }
  const listenHost = getFlag(flags, "listen-host", FEISHU_DEFAULT_AUTH_HOST);
  const listenPort = parseInteger(getFlag(flags, "listen-port"), FEISHU_DEFAULT_AUTH_PORT, "listen-port");
  const callbackPath = getFlag(flags, "callback-path", FEISHU_DEFAULT_AUTH_PATH);
  return `http://${listenHost}:${listenPort}${callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`}`;
}

async function handleProbe(flags) {
  const accountId = getFlag(flags, "account-id", FEISHU_DEFAULT_ACCOUNT);
  const requesterOpenId = getFlag(flags, "requester-open-id");
  const account = readFeishuAccount(accountId);
  const tenantToken = await getTenantAccessToken(account);
  const botPrimary = normalizePrimaryEntry(await getPrimaryCalendar(tenantToken, account.domain));
  const requesterPrimaryList = requesterOpenId
    ? (await getPrimaryCalendarsForOpenIds(tenantToken, account.domain, [requesterOpenId])).map(
        normalizePrimaryEntry,
      )
    : [];

  let userAuthorization = null;
  let requesterAuthorizedPrimary = null;
  const notes = [];

  if (requesterOpenId) {
    try {
      const stored = await getFreshStoredUserAuth(accountId, account, requesterOpenId);
      userAuthorization = buildUserAuthStatus(stored);
      if (stored?.accessToken) {
        requesterAuthorizedPrimary = normalizePrimaryEntry(
          await getPrimaryCalendar(stored.accessToken, account.domain),
        );
      }
    } catch (error) {
      userAuthorization = buildUserAuthStatus(loadStoredUserAuth(accountId, requesterOpenId), error.message);
      notes.push(`Stored user authorization is not usable: ${error.message}`);
    }
  }

  return {
    ok: true,
    accountId,
    botPrimary,
    requesterPrimary: requesterPrimaryList[0] || null,
    requesterAuthorizedPrimary,
    userAuthorization,
    notes,
  };
}

async function handleAuthUrl(flags) {
  const accountId = getFlag(flags, "account-id", FEISHU_DEFAULT_ACCOUNT);
  const account = readFeishuAccount(accountId);
  const redirectUri = buildRedirectUri(flags);
  const state = getFlag(flags, "state", crypto.randomUUID());
  const scopes = getFlagList(flags, "scope");
  const { authUrl, scopes: resolvedScopes } = buildAuthorizeUrl(account, {
    redirectUri,
    state,
    scopes,
  });

  return {
    ok: true,
    accountId,
    redirectUri,
    state,
    scopes: resolvedScopes,
    authUrl,
    notes: [
      "This command only generates the authorization URL. Use auth-start to open a local callback listener and complete the flow on this machine.",
    ],
  };
}

async function handleAuthStart(flags) {
  const accountId = getFlag(flags, "account-id", FEISHU_DEFAULT_ACCOUNT);
  const requesterOpenId = getFlag(flags, "requester-open-id");
  const openBrowser = parseBoolean(getFlag(flags, "open-browser"), false);
  const timeoutSeconds = parseInteger(
    getFlag(flags, "timeout-seconds"),
    300,
    "timeout-seconds",
  );
  const redirectUri = buildRedirectUri(flags);
  const redirectUrl = new URL(redirectUri);
  const account = readFeishuAccount(accountId);
  const state = getFlag(flags, "state", crypto.randomUUID());
  const scopes = getFlagList(flags, "scope");
  const { authUrl, scopes: resolvedScopes } = buildAuthorizeUrl(account, {
    redirectUri,
    state,
    scopes,
  });

  const waitPromise = waitForAuthCallback({
    redirectUri,
    listenHost: redirectUrl.hostname,
    listenPort: Number(redirectUrl.port || (redirectUrl.protocol === "https:" ? 443 : 80)),
    expectedState: state,
    timeoutSeconds,
  });

  const browserOpened = openBrowser ? maybeOpenBrowser(authUrl) : false;
  const { code } = await waitPromise;
  const authData = await exchangeUserAccessToken(account, code);
  const userInfo = await getUserInfo(authData.access_token, account.domain);
  const record = buildUserAuthRecord(accountId, authData, userInfo);
  const notes = [];

  if (!record.openId) {
    throw new Error("Feishu authorization succeeded but open_id is missing");
  }
  if (requesterOpenId && record.openId !== requesterOpenId) {
    throw new Error(`Authorized Feishu user ${record.openId} does not match requester ${requesterOpenId}`);
  }

  saveStoredUserAuth(record);
  let primary = null;
  try {
    primary = normalizePrimaryEntry(await getPrimaryCalendar(record.accessToken, account.domain));
  } catch (error) {
    notes.push(`User authorization has been saved, but calendar access is still unavailable: ${error.message}`);
  }

  return {
    ok: true,
    accountId,
    requesterOpenId: requesterOpenId || null,
    authorizedOpenId: record.openId,
    redirectUri,
    scopes: resolvedScopes,
    browserOpened,
    userAuthorization: buildUserAuthStatus(record),
    requesterAuthorizedPrimary: primary,
    notes: [
      "User authorization has been saved locally. Future create requests for this open_id will prefer the user's own primary calendar.",
      ...notes,
    ],
  };
}

async function handleAuthStatus(flags) {
  const accountId = getFlag(flags, "account-id", FEISHU_DEFAULT_ACCOUNT);
  const requesterOpenId = requireFlag(flags, "requester-open-id");
  const refresh = parseBoolean(getFlag(flags, "refresh"), true);
  const account = readFeishuAccount(accountId);
  const existing = loadStoredUserAuth(accountId, requesterOpenId);

  if (!existing) {
    return {
      ok: true,
      accountId,
      requesterOpenId,
      userAuthorization: buildUserAuthStatus(null),
      requesterAuthorizedPrimary: null,
      notes: ["No saved Feishu user authorization found for this requester."],
    };
  }

  let record = existing;
  let primary = null;
  const notes = [];

  try {
    record = refresh ? await getFreshStoredUserAuth(accountId, account, requesterOpenId) : existing;
    if (record?.accessToken) {
      primary = normalizePrimaryEntry(await getPrimaryCalendar(record.accessToken, account.domain));
    }
  } catch (error) {
    notes.push(`Stored user authorization is not usable: ${error.message}`);
  }

  return {
    ok: true,
    accountId,
    requesterOpenId,
    userAuthorization: buildUserAuthStatus(record, notes[0] || null),
    requesterAuthorizedPrimary: primary,
    notes,
  };
}

async function tryCreateWithUserAuth(options) {
  if (!options.targetOpenId) {
    return null;
  }

  let record;
  try {
    record = await getFreshStoredUserAuth(options.accountId, options.account, options.targetOpenId);
  } catch (error) {
    options.notes.push(`Saved user authorization is not usable for ${options.targetOpenId}: ${error.message}`);
    return null;
  }
  if (!record?.accessToken) {
    options.notes.push(`No saved user authorization found for ${options.targetOpenId}.`);
    return null;
  }

  let primary;
  try {
    primary = normalizePrimaryEntry(await getPrimaryCalendar(record.accessToken, options.account.domain));
  } catch (error) {
    options.notes.push(`Saved user authorization cannot read the requester's primary calendar: ${error.message}`);
    return null;
  }

  if (!primary.calendarId) {
    options.notes.push("Saved user authorization did not resolve a primary calendar.");
    return null;
  }
  if (!roleCanWrite(primary.role)) {
    options.notes.push(
      `Saved user authorization resolved primary calendar role ${primary.role}; cannot write directly.`,
    );
    return {
      record,
      primary,
      strategy: "requester-user-token-readonly",
    };
  }

  try {
    const event = await createEvent(record.accessToken, options.account.domain, {
      calendarId: primary.calendarId,
      title: options.title,
      description: options.description,
      needNotification: options.needNotification,
      startTime: options.startTime,
      endTime: options.endTime,
      visibility: options.visibility,
      attendeeAbility: options.attendeeAbility,
      freeBusyStatus: options.freeBusyStatus,
      location: options.location,
      reminders: options.reminders,
    });
    const invitees = unique(getFlagList(options.flags, "invite-open-id"));
    const addedAttendees =
      invitees.length > 0
        ? await addAttendees(record.accessToken, options.account.domain, {
            calendarId: primary.calendarId,
            eventId: event.event_id,
            openIds: invitees,
            needNotification: options.needNotification,
          })
        : [];

    return {
      strategy: "requester-user-token",
      record,
      primary,
      event,
      invitees,
      addedAttendees,
    };
  } catch (error) {
    options.notes.push(`Direct write via saved user authorization failed: ${error.message}`);
    return {
      strategy: "requester-user-token-error",
      record,
      primary,
    };
  }
}

async function handleCreate(flags) {
  const accountId = getFlag(flags, "account-id", FEISHU_DEFAULT_ACCOUNT);
  const title = requireFlag(flags, "title");
  const start = requireFlag(flags, "start");
  const end = requireFlag(flags, "end");
  const timezone = getFlag(flags, "timezone", FEISHU_DEFAULT_TZ);
  const requesterOpenId = getFlag(flags, "requester-open-id");
  const targetOpenId = getFlag(flags, "target-open-id", requesterOpenId);
  const locationName = getFlag(flags, "location-name");
  const locationAddress = getFlag(flags, "location-address");
  const description = getFlag(flags, "description");
  const needNotification = parseBoolean(getFlag(flags, "need-notification"), true);
  const attendeeAbility = getFlag(flags, "attendee-ability", "can_see_others");
  const visibility = getFlag(flags, "visibility", "default");
  const freeBusyStatus = getFlag(flags, "free-busy-status", "busy");
  const reminderMinutes = getFlagList(flags, "reminder-minutes").map((value) => ({
    minutes: Number(value),
  }));

  const account = readFeishuAccount(accountId);
  const notes = [];
  const startTime = buildEventTime(start, timezone);
  const endTime = buildEventTime(end, timezone);
  const location =
    locationName || locationAddress
      ? { name: locationName || undefined, address: locationAddress || undefined }
      : undefined;
  const reminders = reminderMinutes.length > 0 ? reminderMinutes : undefined;

  const directResult = await tryCreateWithUserAuth({
    accountId,
    account,
    targetOpenId,
    title,
    description,
    needNotification,
    startTime,
    endTime,
    visibility,
    attendeeAbility,
    freeBusyStatus,
    location,
    reminders,
    notes,
    flags,
  });

  if (directResult?.event) {
    return {
      ok: true,
      accountId,
      strategy: directResult.strategy,
      calendarId: directResult.primary.calendarId,
      eventId: directResult.event.event_id,
      organizerCalendarId: directResult.event.organizer_calendar_id || null,
      requesterOpenId: requesterOpenId || null,
      requesterCalendarRole: directResult.primary.role || null,
      botCalendarRole: null,
      summary: directResult.event.summary || title,
      startTime: directResult.event.start_time,
      endTime: directResult.event.end_time,
      invitees: directResult.invitees,
      attendeesAdded: directResult.addedAttendees.length,
      userAuthorization: sanitizeUserAuthRecord(directResult.record),
      notes,
    };
  }

  const tenantToken = await getTenantAccessToken(account);
  const botPrimary = normalizePrimaryEntry(await getPrimaryCalendar(tenantToken, account.domain));
  let requesterPrimary = null;
  if (targetOpenId) {
    const [entry] = await getPrimaryCalendarsForOpenIds(tenantToken, account.domain, [targetOpenId]);
    requesterPrimary = entry ? normalizePrimaryEntry(entry) : null;
  }

  let strategy = "bot-primary";
  let calendarId = botPrimary.calendarId;
  if (requesterPrimary?.calendarId && roleCanWrite(requesterPrimary.role)) {
    strategy = "requester-primary";
    calendarId = requesterPrimary.calendarId;
  } else if (requesterPrimary?.calendarId) {
    notes.push(
      `Requester primary calendar role is ${requesterPrimary.role}; falling back to bot primary calendar.`,
    );
  } else if (targetOpenId) {
    notes.push("Requester primary calendar was not found; falling back to bot primary calendar.");
  }

  if (!calendarId) {
    throw new Error("No writable calendar_id resolved for event creation");
  }

  const event = await createEvent(tenantToken, account.domain, {
    calendarId,
    title,
    description,
    needNotification,
    startTime,
    endTime,
    visibility,
    attendeeAbility,
    freeBusyStatus,
    location,
    reminders,
  });

  const explicitInvitees = getFlagList(flags, "invite-open-id");
  const fallbackInvitees = strategy === "bot-primary" && targetOpenId ? [targetOpenId] : [];
  const invitees = unique([...explicitInvitees, ...fallbackInvitees]);
  const addedAttendees =
    invitees.length > 0
      ? await addAttendees(tenantToken, account.domain, {
          calendarId,
          eventId: event.event_id,
          openIds: invitees,
          needNotification,
        })
      : [];

  return {
    ok: true,
    accountId,
    strategy,
    calendarId,
    eventId: event.event_id,
    organizerCalendarId: event.organizer_calendar_id || null,
    requesterOpenId: requesterOpenId || null,
    requesterCalendarRole: requesterPrimary?.role || null,
    botCalendarRole: botPrimary.role,
    summary: event.summary || title,
    startTime: event.start_time,
    endTime: event.end_time,
    invitees,
    attendeesAdded: addedAttendees.length,
    notes,
  };
}

async function handleDelete(flags) {
  const accountId = getFlag(flags, "account-id", FEISHU_DEFAULT_ACCOUNT);
  const calendarId = requireFlag(flags, "calendar-id");
  const eventId = requireFlag(flags, "event-id");
  const requesterOpenId = getFlag(flags, "requester-open-id");
  const account = readFeishuAccount(accountId);
  const notes = [];

  if (requesterOpenId) {
    try {
      const record = await getFreshStoredUserAuth(accountId, account, requesterOpenId);
      if (record?.accessToken) {
        await deleteEvent(record.accessToken, account.domain, { calendarId, eventId });
        return {
          ok: true,
          accountId,
          calendarId,
          eventId,
          deleted: true,
          strategy: "requester-user-token",
          requesterOpenId,
          userAuthorization: sanitizeUserAuthRecord(record),
          notes,
        };
      }
    } catch (error) {
      notes.push(`Delete via saved user authorization failed: ${error.message}`);
    }
  }

  const tenantToken = await getTenantAccessToken(account);
  await deleteEvent(tenantToken, account.domain, { calendarId, eventId });
  return {
    ok: true,
    accountId,
    calendarId,
    eventId,
    deleted: true,
    strategy: "tenant-token",
    requesterOpenId: requesterOpenId || null,
    notes,
  };
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    throw new Error(
      "Usage: feishu-calendar.mjs <probe|auth-url|auth-start|auth-status|create|delete> [--flags]",
    );
  }

  let result;
  if (command === "probe") {
    result = await handleProbe(flags);
  } else if (command === "auth-url") {
    result = await handleAuthUrl(flags);
  } else if (command === "auth-start") {
    result = await handleAuthStart(flags);
  } else if (command === "auth-status") {
    result = await handleAuthStatus(flags);
  } else if (command === "create") {
    result = await handleCreate(flags);
  } else if (command === "delete") {
    result = await handleDelete(flags);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  print(result);
}

main().catch((error) => {
  print({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
