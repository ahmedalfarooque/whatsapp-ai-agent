# Users, roles and permissions

The dashboard has real, database-backed users. Everything below is enforced **by the server on every request**
(`src/dashboard/authorize.ts`); hiding a menu item in the browser is only a convenience.

## The permanent Super Admin

The account that ran first-time setup (the oldest `admin_users` row) is the **permanent Super Admin**
(`role = super_admin`, `is_protected = 1`, migration `019_users_permissions.sql`). Its id, username and password hash are never
touched by the migration. It has every WhatsApp account (including future ones), every feature, and the connection,
configuration and Users capabilities. The Users page and API refuse to edit, disable, downgrade, re-assign, reset the password
of, or sign out the protected account — by an Admin **or by itself** — and nobody can create another Super Admin or promote
themselves (there is no hard delete of users at all; disabling keeps history intact).

## Roles

| Role | Accounts | What it can do |
|---|---|---|
| Super Admin | all, always | everything |
| Admin | assigned (or "all accounts", granted only by the Super Admin) | every feature on its accounts; manages Manager/User/Custom users within its own accounts. Connection and configuration pages only when the Super Admin grants them |
| Manager | assigned only | view **and edit** the operational features (offers, documents, templates, customers…); cannot delete, no connection/configuration/users |
| User | assigned only | read-only operational pages |
| Custom | assigned only | exactly the features and levels picked, **per account** |

New Manager/User/Custom users have **no access until accounts are assigned** (deny by default). Pre-existing users keep today's
behaviour (a full admin) — migration `019` only adds columns/tables with safe defaults.

## Features and levels

Features map to real pages and API routes: dashboard & reports, conversations, customers, requests & appointments, human
support queue, offers, catalogues, documents, business profile, menus & templates, AI knowledge & settings, notifications,
activity logs. Levels: **view** (GET), **edit** (POST/PUT/PATCH), **manage** (DELETE). Any API route not listed in the rule table
is Super-Admin-only, so a new route is closed until it is deliberately opened.

## Account isolation

The selected account (`X-Whatsapp-Account` header / `?account=`) and any account id in a URL path are checked against the user's
assigned accounts before any handler runs (403 for an account the user may not open, 404 for one that does not exist).
Documents, offers, catalogues, conversations and customers are all read inside that account's context.

## Creating users

`POST /api/dashboard/users` (Users & Permissions page): name, email (also the sign-in name), initial password (minimum 12
characters, hashed with the same scrypt scheme as sign-in, never stored, returned or logged in clear text), role, accounts and
(for Custom) permissions. Duplicate emails are refused case-insensitively. Disabling a user ends their sessions immediately and
blocks sign-in; password reset and access changes also revoke their sessions. Every change is recorded in `admin_audit_log`
(who changed whom and what — never a password).
