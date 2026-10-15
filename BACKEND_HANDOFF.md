# Backend integration handoff

Frontend API base URL: `https://thriftcircle.onrender.com/api` (in `frontend/config.js`). The frontend appends API paths such as `/auth/signup` and `/groups`; do not add another `/api` prefix to individual routes.

## Group creation request

The create form submits the backend's required fields to `POST /groups`:

```json
{
  "groupName": "Family Savings Circle",
  "contributionAmount": 50000,
  "frequency": "weekly",
  "startDate": "2026-10-16",
  "contributionDeadline": "2026-10-17"
}
```

`frequency` is sent in lowercase (`weekly` or `monthly`). The frontend also saves the chosen rules with `PUT /groups/:groupId/rules`, using `gracePeriodDays`, `allowLateSubmission`, and `maxMembers`.

## CORS on Render

The browser cannot fix a CORS rejection. Set the backend Render service environment variable `CORS_ORIGINS` to the exact deployed frontend origin (scheme and hostname only, no path). The local backend `.env` currently lists `http://localhost:3000` and `https://thrift-store-zeta-inky.vercel.app`; confirm that the same `CORS_ORIGINS` value is set in Render. The backend CORS middleware allows `OPTIONS` preflight, `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and the `Content-Type` and `Authorization` headers. Redeploy/restart after changing Render environment values.

## Other contract details reflected in the frontend

- Signup sends `fullName`, `email`, `phoneNumber`, `password`, and selected `role`.
- Login sends either `email` or `phoneNumber`, with `password`.
- Evidence upload sends multipart form data with file field `file` for an existing contribution.
- Evidence review sends `{ "decision": "APPROVED" | "REJECTED", "reviewNote": "..." }`.
- Issue reporting sends `{ "contributionId": "...", "description": "..." }`.
- Payout creation sends `{ "cycleNumber": 1 }`; payout ordering sends `{ "order": [{ "userId": "...", "payoutOrder": 1 }] }`.

The current backend does not expose endpoints for changing an active member's status or manually creating a cycle, so the frontend does not send those requests. Password reset delivery also needs backend support: the current forgot-password controller creates the code but does not deliver it to the user.

## Render service setup

The backend `package.json` is in `backend/backend`. For a Render Web Service, use `backend/backend` as the Root Directory and `npm start` as the Start Command. The app listens on Render's `PORT` and binds to `0.0.0.0`.
