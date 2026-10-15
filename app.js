(()=>{
class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const segment = (value) => {
  if (value === undefined || value === null || value === "")
    throw new TypeError("A resource ID is required.");
  return encodeURIComponent(String(value));
};
function createApi({
  baseUrl,
  timeout = 20000,
  getToken = () => null,
  getRefreshToken = () => null,
  onTokensRefreshed = () => {},
  onUnauthorized = () => {},
  fetchImpl = fetch,
}) {
  if (!baseUrl) throw new TypeError("An API base URL is required.");
  const base = baseUrl.replace(/\/$/, "");
  async function request(
    path,
    { method = "GET", body, authenticated = true, signal } = {},
    retried = false,
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const headers = { Accept: "application/json" };
    const token = getToken();
    if (authenticated && token) headers.Authorization = `Bearer ${token}`;
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart)
      headers["Content-Type"] = "application/json";
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : multipart
              ? body
              : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          if (response.ok)
            throw new ApiError(
              "The server returned an invalid response.",
              response.status,
              "INVALID_RESPONSE",
            );
        }
      }
      if (!response.ok) {
        if (response.status === 401 && authenticated) {
          if (
            !retried &&
            data?.code === "TOKEN_EXPIRED" &&
            getRefreshToken()
          ) {
            try {
              const tokens = await request(
                "/auth/refresh",
                {
                  method: "POST",
                  body: { refreshToken: getRefreshToken() },
                  authenticated: false,
                },
                true,
              );
              if (tokens?.accessToken && tokens?.refreshToken) {
                onTokensRefreshed(tokens);
                return await request(
                  path,
                  { method, body, authenticated, signal },
                  true,
                );
              }
            } catch {
              onUnauthorized();
            }
          } else {
            onUnauthorized();
          }
        }
        const message =
          data?.message ||
          data?.error?.message ||
          (typeof data?.error === "string" ? data.error : null) ||
          `Request failed (${response.status}).`;
        throw new ApiError(
          message,
          response.status,
          data?.code || data?.error?.code,
          data,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted)
        throw new ApiError(
          "The request was cancelled or timed out. Please try again.",
          0,
          "REQUEST_ABORTED",
        );
      throw new ApiError(
        "Unable to reach ThriftCircle. Check your connection and try again.",
        0,
        "NETWORK_ERROR",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  const groupPath = (id) => `/groups/${segment(id)}`;
  const send = (path, method, body, authenticated = true) =>
    request(path, { method, body, authenticated });
  return Object.freeze({
    request,
    health: () => request("/health", { authenticated: false }),
    signup: (body) => send("/auth/signup", "POST", body, false),
    login: (body) => send("/auth/login", "POST", body, false),
    forgotPassword: (body) =>
      send("/auth/forgot-password", "POST", body, false),
    resetPassword: (body) => send("/auth/reset-password", "POST", body, false),
    refresh: (body) => send("/auth/refresh", "POST", body, false),
    logout: (body) => send("/auth/logout", "POST", body, false),
    createGroup: (body) => send("/groups", "POST", body),
    joinGroup: (body) => send("/groups/join", "POST", body),
    myGroups: () => request("/groups/mine"),
    group: (id) => request(groupPath(id)),
    groupRules: (id) => request(`${groupPath(id)}/rules`),
    updateGroupRules: (id, body) =>
      send(`${groupPath(id)}/rules`, "PUT", body),
    pendingMembers: (id) => request(`${groupPath(id)}/pending`),
    approveMember: (id, userId, reason = "") =>
      send(`${groupPath(id)}/members/${segment(userId)}/approve`, "PATCH", {
        status: "APPROVED",
        reason,
      }),
    rejectMember: (id, userId, reason = "") =>
      send(`${groupPath(id)}/members/${segment(userId)}/reject`, "PATCH", {
        status: "REJECTED",
        reason,
      }),
    contributions: (id) => request(`${groupPath(id)}/contributions`),
    recordContribution: (id, body) =>
      send(`${groupPath(id)}/contributions`, "POST", body),
    contribution: (id) => request(`/contributions/${segment(id)}`),
    uploadEvidence: (id, formData) => {
      if (!(formData instanceof FormData))
        throw new TypeError("Evidence must be supplied as FormData.");
      return send(`/contributions/${segment(id)}/evidence`, "POST", formData);
    },
    reviewEvidence: (id, body) =>
      send(`/evidence/${segment(id)}/review`, "PATCH", body),
    reportIssue: (body) => send("/issues/report", "POST", body),
    issues: (id) => request(`${groupPath(id)}/issues`),
    resolveIssue: (id, body) =>
      send(`/issues/${segment(id)}/resolve`, "PATCH", body),
    currentCycle: (id) => request(`${groupPath(id)}/cycles/current`),
    triggerPayout: (id, cycleNumber) =>
      send(`${groupPath(id)}/payouts`, "POST", { cycleNumber }),
    payouts: (id) => request(`${groupPath(id)}/payouts`),
    reorderPayouts: (id, order) =>
      send(`${groupPath(id)}/payouts/order`, "PUT", { order }),
    approvePayout: (id) => send(`/payouts/${segment(id)}/approve`, "PATCH"),
    organizerDashboard: (id) => request(`${groupPath(id)}/dashboard/organizer`),
    memberDashboard: (id) => request(`${groupPath(id)}/dashboard/member`),
    outstanding: (id) => request(`${groupPath(id)}/outstanding`),
    progress: (id) => request(`${groupPath(id)}/progress`),
    notifications: () => request("/notifications"),
    readAllNotifications: () => send("/notifications/read-all", "PATCH"),
    readNotification: (id) =>
      send(`/notifications/${segment(id)}/read`, "PATCH"),
  });
}

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const money = (value) =>
  "₦" + Number(value || 0).toLocaleString("en-NG");
const initials = (value) =>
  String(value || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
const idOf = (value) =>
  typeof value === "string" ? value : value?.id || value?._id || "";
const unwrap = (value) => value?.data ?? value;
const memberIdOf = (member) => idOf(member?.userId || member);
function normalizeMember(member) {
  const userRecord = member?.userId && typeof member.userId === "object"
    ? member.userId
    : member;
  return {
    ...member,
    ...userRecord,
    id: idOf(userRecord) || idOf(member?.userId),
    membershipId: idOf(member),
    status: String(member?.status || "active").toUpperCase(),
    joinedAt: member?.joinedAt,
    position: member?.payoutOrder || member?.position,
  };
}
function normalizeGroup(value) {
  const response = unwrap(value) || {};
  const groupRecord = response.group || response;
  return {
    ...groupRecord,
    id: idOf(groupRecord),
    name: groupRecord.name || groupRecord.groupName || "Savings Group",
    members: (response.members || groupRecord.members || []).map(normalizeMember),
    role: response.callerRole || groupRecord.role,
  };
}
function normalizeContribution(value) {
  const contribution = unwrap(value) || {};
  return {
    ...contribution,
    id: idOf(contribution),
    paymentDate: contribution.paymentDate || contribution.dueDate,
    cycle: contribution.cycle || (contribution.cycleNumber ? `Cycle ${contribution.cycleNumber}` : ""),
    feedback: contribution.feedback || contribution.issueReason || "",
    member: contribution.member || contribution.memberId,
  };
}
const listOf = (value, key) => {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.items)) return data.items;
  throw new TypeError("The server response did not include the expected list.");
};
const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};
function validatePayoutOrder(members, order) {
  if (!Array.isArray(order) || order.length !== members.length)
    throw new Error("The payout order must include every member.");
  const ids = members.map((member) => String(idOf(member)));
  const proposed = order.map((entry) => String(entry.userId));
  if (
    new Set(proposed).size !== proposed.length ||
    proposed.some((id) => !ids.includes(id))
  )
    throw new Error("Each member must appear exactly once.");
  order.forEach((entry, index) => {
    if (entry.payoutOrder !== index + 1)
      throw new Error("Payout positions must be consecutive.");
  });
  return order;
}
function fixtureData() {
  const names = [
    "Ada Okafor",
    "Chidi Nwosu",
    "David Ibeh",
    "Blessing Eze",
    "Grace Danjum",
    "Emeka Ibeh",
    "Joy Adebayo",
    "Ada Victor",
    "John Okafor",
    "Austin Bila",
  ];
  const members = names.map((name, i) => ({
    id: `member-${i + 1}`,
    name,
    fullName: name,
    phoneNumber: [
      "08123456780",
      "08131056080",
      "07011457610",
      "08131056080",
      "08131056080",
      "08023457680",
    ][i % 6],
    status: [1, 3, 6].includes(i) ? "INACTIVE" : "ACTIVE",
    joinedAt: [
      "2026-06-30",
      "2026-07-01",
      "2026-07-10",
      "2026-07-12",
      "2026-07-16",
      "2026-07-17",
      "2026-07-20",
      "2026-07-30",
      "2026-07-30",
      "2026-07-31",
    ][i],
    position: i + 1,
  }));
  const groups = [
    {
      id: "family",
      name: "Family Savings Group",
      description: "Family Savings Circle",
      memberCount: 10,
      contributionAmount: 50000,
      frequency: "MONTHLY",
      status: "ACTIVE",
      type: "FAMILY",
      inviteCode: "6B9X2C",
      bankName: "GT Bank",
      accountName: "Family Savings Group",
      accountNumber: "0123456789",
      reference: "Sept Contribution",
      members,
      rules: {
        latePaymentDays: 3,
        missedContributions: "Member contacts organiser",
        leavingGroup: "Requires organiser approval",
      },
    },
    {
      id: "atiba",
      name: "Oke Atiba Group",
      description: "Oke Atiba Group",
      memberCount: 10,
      contributionAmount: 20000,
      frequency: "MONTHLY",
      status: "ACTIVE",
      type: "AJO_ESUSU",
      inviteCode: "ATIBA2",
      members,
    },
  ];
  const contributions = [
    {
      id: "atiba-current",
      groupId: "atiba",
      member: members[0],
      amount: 20000,
      paymentDate: "2026-05-18",
      status: "DUE",
      reference: "May Contribution",
    },
    {
      id: "current",
      groupId: "family",
      member: members[0],
      amount: 50000,
      paymentDate: "2026-09-30",
      status: "DUE",
      cycle: "September 2026",
      reference: "Sept Contribution",
    },
    ...["2026-08-25", "2026-07-25", "2026-06-25", "2026-05-25"].map(
      (date, i) => ({
        id: `contribution-${i}`,
        groupId: "family",
        member: members[i],
        amount: 50000,
        paymentDate: date,
        status: "CONFIRMED",
        cycle: ["Aug 2026", "Jul 2026", "Jun 2026", "May 2026"][i],
      }),
    ),
    ...["2026-04-18", "2026-03-18", "2026-02-18", "2026-01-18"].map(
      (date, i) => ({
        id: `atiba-${i}`,
        groupId: "atiba",
        amount: 20000,
        paymentDate: date,
        status: "CONFIRMED",
      }),
    ),
  ];
  const reviews = [
    "Wemimo Olayiwola",
    "Adesewa Olaniyi",
    "Fehintola Adebayo",
    "Semilore Badipe",
  ].map((name, i) => ({
    id: `review-${i}`,
    evidenceId: `evidence-${i}`,
    groupId: "family",
    member: { id: `review-member-${i}`, name },
    groupName: ["Group A", "Group B", "Group A", "Group C"][i],
    amount: [5000, 20000, 5000, 10000][i],
    paymentDate: "2026-09-12",
    status: "UNDER_REVIEW",
    reference: "September Contribution",
  }));
  const payouts = [
    "Ada Okafor",
    "Bola Adebayo",
    "Chidi Nwosu",
    "Damilola Yusuf",
    "Ezinne Obi",
  ].map((name, i) => ({
    id: `payout-${i}`,
    memberId: `payout-member-${i}`,
    member: { id: `payout-member-${i}`, name },
    position: i + 1,
    amount: 200000,
    payoutDate: [
      "2026-09-05",
      "2026-09-12",
      "2026-09-19",
      "2026-09-26",
      "2026-09-30",
    ][i],
    status: i === 0 ? "completed" : i === 1 ? "pending_approval" : "upcoming",
  }));
  const notifications = [
    {
      id: "notice-1",
      message: "Ada submitted payment evidence",
      createdAt: "2026-09-12T10:00:00Z",
      read: false,
    },
    {
      id: "notice-2",
      message: "Michael’s contribution is overdue",
      createdAt: "2026-09-12T09:00:00Z",
      read: false,
    },
    {
      id: "notice-3",
      message: "Chidi’s payment confirmed",
      createdAt: "2026-09-12T08:00:00Z",
      read: true,
    },
    {
      id: "notice-4",
      message: "Payout order updated",
      createdAt: "2026-09-11T08:00:00Z",
      read: true,
    },
  ];
  return {
    groups,
    contributions,
    reviews,
    payouts,
    notifications,
    pending: [
      {
        id: "pending-1",
        name: "Bola Adebayo",
        status: "PENDING",
        phoneNumber: "08123456780",
      },
    ],
    issues: [
      {
        id: "issue-sample",
        title: "Payment Issue",
        description: "The payment evidence needs organizer review.",
        category: "PAYMENT",
        status: "PENDING",
        amount: 50000,
        reference: "TRF-1042",
      },
    ],
    dashboard: {
      confirmed: 6,
      pending: 1,
      overdue: 1,
      totalMembers: 10,
      collected: 80000,
      target: 100000,
    },
    cycle: {
      name: "September 2026 Cycle",
      number: 3,
      week: 4,
      totalWeeks: 10,
      status: "ACTIVE",
    },
  };
}

const screenCatalog = [
  {
    "id": "663:1355",
    "name": "Contribution details",
    "width": 402,
    "height": 1477,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "contribution-details",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "688:4152",
    "name": "Payment Instructions",
    "width": 402,
    "height": 1070,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "payment-instructions",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "703:4502",
    "name": "Upload Evidence",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "829:1964",
    "name": "Upload Evidence(loading state)",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "loading",
    "reference": "saved"
  },
  {
    "id": "829:2044",
    "name": "Upload Evidence(failed state)",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "error",
    "reference": "saved"
  },
  {
    "id": "829:2124",
    "name": "Upload Evidence(Success state)",
    "width": 402,
    "height": 916,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "success",
    "reference": "saved"
  },
  {
    "id": "733:793",
    "name": "Correction details",
    "width": 402,
    "height": 947,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "correction-required",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "856:2781",
    "name": "Update submission",
    "width": 402,
    "height": 1123,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "update-submission",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "856:3137",
    "name": "Review & Resubmit",
    "width": 402,
    "height": 1273,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-resubmit",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "703:5214",
    "name": "Review submission",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "856:2561",
    "name": "Review submission (loading)",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "loading",
    "reference": "saved"
  },
  {
    "id": "856:3588",
    "name": "Review submission",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-resubmit",
    "state": "loading",
    "reference": "saved"
  },
  {
    "id": "848:2472",
    "name": "submission(error)",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "error",
    "reference": "saved"
  },
  {
    "id": "726:5924",
    "name": "submission(Succes state)",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "submission-success",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "856:3671",
    "name": "submission(Succes state)",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "submission-success",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "733:1341",
    "name": "Dashboard",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "dashboard",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "900:2185",
    "name": "Contribution details",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "contribution-details",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "952:2595",
    "name": "Payment Instructions",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "payment-instructions",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "952:3947",
    "name": "Upload Evidence",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "952:4965",
    "name": "Upload Evidence (loading)",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "952:5345",
    "name": "Review evidence submission",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "976:5519",
    "name": "Review evidence submission (loading state)",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "976:5640",
    "name": "Review evidence submission(error state)",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "976:5795",
    "name": "Review evidence submission(success state)",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "976:6388",
    "name": "Correction required",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "correction-required",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "976:6513",
    "name": "Update Submission",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "update-submission",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "983:6711",
    "name": "Review & Submit",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-resubmit",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "983:6883",
    "name": "Review Submission",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "983:7010",
    "name": "Review Submission",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "review-submission",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "952:5145",
    "name": "Upload Evidence (failed state)",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "952:5241",
    "name": "Upload Evidence (Success state)",
    "width": 1440,
    "height": 1024,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "upload-evidence",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "663:1088",
    "name": "Member's dashboard",
    "width": 402,
    "height": 874,
    "section": "Mayokun's section(Hi-fidelity Screens)",
    "route": "dashboard",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "865:1786",
    "name": "Splash Screen",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "splash",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "865:1790",
    "name": "Welcome",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "welcome",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "881:2766",
    "name": "Role selection Default",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "role",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "885:4780",
    "name": "Role selection Member",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "role",
    "state": "member",
    "reference": "pending"
  },
  {
    "id": "885:4841",
    "name": "Role selection Organizer",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "role",
    "state": "organizer",
    "reference": "pending"
  },
  {
    "id": "885:4906",
    "name": "Sign up",
    "width": 402,
    "height": 988,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "signup",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "885:5357",
    "name": "Log in",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "login",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "885:5433",
    "name": "Forgot password",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "forgot-password",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "885:5498",
    "name": "Reset Password",
    "width": 402,
    "height": 874,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "reset-password",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "865:1942",
    "name": "Welcome screen",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "welcome",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "865:1946",
    "name": "Choose role",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "role",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1929:3879",
    "name": "Choose role (Organizer)",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "role",
    "state": "organizer",
    "reference": "pending"
  },
  {
    "id": "1934:3988",
    "name": "Choose role (Member)",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "role",
    "state": "member",
    "reference": "pending"
  },
  {
    "id": "1934:4156",
    "name": "Create an account",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "signup",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1934:4351",
    "name": "Password Updated success modal",
    "width": 462,
    "height": 172,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "password-updated",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "1934:4359",
    "name": "Login",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "login",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1934:4441",
    "name": "Forgot password",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "forgot-password",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1934:4523",
    "name": "Reset password",
    "width": 1440,
    "height": 1024,
    "section": "Onboarding and Auth flow( high fidelity)",
    "route": "reset-password",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "700:2413",
    "name": "contribution details",
    "width": 390,
    "height": 562,
    "section": "Marvellous hi-fi",
    "route": "contribution-details",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "700:2426",
    "name": "outstanding contribution card",
    "width": 390,
    "height": 629,
    "section": "Marvellous hi-fi",
    "route": "outstanding-contribution",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "700:2436",
    "name": "member dash board",
    "width": 1440,
    "height": 1024,
    "section": "Marvellous hi-fi",
    "route": "dashboard",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "954:4897",
    "name": "member dash board",
    "width": 1440,
    "height": 1024,
    "section": "Marvellous hi-fi",
    "route": "dashboard",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "954:7443",
    "name": "member dash board",
    "width": 1440,
    "height": 1024,
    "section": "Marvellous hi-fi",
    "route": "dashboard",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "954:7557",
    "name": "member dash board",
    "width": 1440,
    "height": 1024,
    "section": "Marvellous hi-fi",
    "route": "dashboard",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "954:5039",
    "name": "member dashboard - contribution history",
    "width": 1440,
    "height": 1024,
    "section": "Marvellous hi-fi",
    "route": "history",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "874:1795",
    "name": "member dashboard",
    "width": 390,
    "height": 874,
    "section": "Marvellous hi-fi",
    "route": "dashboard",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "874:1819",
    "name": "contribution history",
    "width": 390,
    "height": 874,
    "section": "Marvellous hi-fi",
    "route": "history",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1971:3689",
    "name": "Organizer Dashboard",
    "width": 402,
    "height": 1375,
    "section": "Marvellous hi-fi",
    "route": "dashboard",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "877:1756",
    "name": "Pending Issues screen",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "wireframe"
  },
  {
    "id": "877:1817",
    "name": "View issue details",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "issue-details",
    "state": "default",
    "reference": "wireframe"
  },
  {
    "id": "877:1881",
    "name": "Add/confirm reason",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "confirm-issue",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "877:1922",
    "name": "Issue reported",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "issue-reported",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "877:1953",
    "name": "Loading page",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "877:1971",
    "name": "Error page",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "877:1992",
    "name": "Validation error page",
    "width": 393,
    "height": 852,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "validation-error",
    "reference": "pending"
  },
  {
    "id": "877:2013",
    "name": "Pending issues Closed",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "wireframe"
  },
  {
    "id": "877:2122",
    "name": "Loading page",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "877:2136",
    "name": "Error page",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "877:2156",
    "name": "Validation error page",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "validation-error",
    "reference": "pending"
  },
  {
    "id": "877:2196",
    "name": "Pending issues expanded",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "877:2339",
    "name": "Issue details",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issue-details",
    "state": "default",
    "reference": "wireframe"
  },
  {
    "id": "877:2459",
    "name": "Add/confirm reason",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "confirm-issue",
    "state": "default",
    "reference": "wireframe"
  },
  {
    "id": "877:2517",
    "name": "Issue reported page",
    "width": 1440,
    "height": 1024,
    "section": "Ebube's Hi-fi",
    "route": "issue-reported",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "997:2862",
    "name": "Pending payment issue state",
    "width": 402,
    "height": 1018,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1003:3046",
    "name": "Pending payment issue state",
    "width": 402,
    "height": 874,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1315:4689",
    "name": "Pending payment issue state",
    "width": 402,
    "height": 874,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1337:4818",
    "name": "Pending payment issue state",
    "width": 402,
    "height": 874,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1300:4326",
    "name": "Platform Search and Modal",
    "width": 1072,
    "height": 507,
    "section": "Ebube's Hi-fi",
    "route": "issues",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "698:1245",
    "name": "Organizer Dashboard",
    "width": 402,
    "height": 1375,
    "section": "Opeyemi Hi-Fi",
    "route": "dashboard",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "736:2750",
    "name": "Contribution active mobile",
    "width": 402,
    "height": 1269,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1397:4025",
    "name": "Contribution pending mobile",
    "width": 402,
    "height": 874,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "pending",
    "reference": "pending"
  },
  {
    "id": "1397:5038",
    "name": "Contribution loading mobile",
    "width": 402,
    "height": 874,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "1397:4524",
    "name": "Contribution Overdue mobile",
    "width": 402,
    "height": 874,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "overdue",
    "reference": "pending"
  },
  {
    "id": "1397:4679",
    "name": "Contribution Inactive",
    "width": 402,
    "height": 874,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "inactive",
    "reference": "pending"
  },
  {
    "id": "1397:5193",
    "name": "Contribution Error",
    "width": 402,
    "height": 874,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "1397:3173",
    "name": "COntribution Payment confirm screen",
    "width": 402,
    "height": 1074,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "771:2223",
    "name": "Member List",
    "width": 402,
    "height": 1063,
    "section": "Opeyemi Hi-Fi",
    "route": "members",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1397:6150",
    "name": "Member Status",
    "width": 402,
    "height": 982,
    "section": "Opeyemi Hi-Fi",
    "route": "member-status",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1426:6891",
    "name": "Member Inactive Status",
    "width": 402,
    "height": 982,
    "section": "Opeyemi Hi-Fi",
    "route": "member-status",
    "state": "inactive",
    "reference": "pending"
  },
  {
    "id": "1426:7033",
    "name": "Change Member Status",
    "width": 402,
    "height": 982,
    "section": "Opeyemi Hi-Fi",
    "route": "change-member-status",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1426:7148",
    "name": "Status updated succefully",
    "width": 402,
    "height": 982,
    "section": "Opeyemi Hi-Fi",
    "route": "contribution-status",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "1426:7261",
    "name": "Status error state",
    "width": 402,
    "height": 982,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "835:5758",
    "name": "Organizer Dashboard (No Active cycle)",
    "width": 402,
    "height": 874,
    "section": "Opeyemi Hi-Fi",
    "route": "dashboard",
    "state": "inactive",
    "reference": "pending"
  },
  {
    "id": "835:6149",
    "name": "Organizer Dashboard (Loading)",
    "width": 402,
    "height": 947,
    "section": "Opeyemi Hi-Fi",
    "route": "dashboard",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "945:9038",
    "name": "Organizer dashboard desktop",
    "width": 1440,
    "height": 1213,
    "section": "Opeyemi Hi-Fi",
    "route": "dashboard",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1041:3123",
    "name": "Organizer dashboard Inactiive cycle desktop",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "dashboard",
    "state": "inactive",
    "reference": "saved"
  },
  {
    "id": "945:8884",
    "name": "Member List",
    "width": 1440,
    "height": 1382,
    "section": "Opeyemi Hi-Fi",
    "route": "members",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1441:10025",
    "name": "Member detail desktop",
    "width": 1440,
    "height": 1310,
    "section": "Opeyemi Hi-Fi",
    "route": "member-details",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1441:10068",
    "name": "Member Status Active",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "member-status",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1568:3890",
    "name": "Member Status Inactive",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "member-status",
    "state": "inactive",
    "reference": "pending"
  },
  {
    "id": "1568:4526",
    "name": "Change status error",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "change-member-status",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "1568:5004",
    "name": "Status changed successfully",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "change-member-status",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "1568:5164",
    "name": "Change status",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "change-member-status",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1167:2979",
    "name": "Organiser Dashboard loading",
    "width": 1440,
    "height": 1165,
    "section": "Opeyemi Hi-Fi",
    "route": "dashboard",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "1167:3092",
    "name": "Contribution Monitoring",
    "width": 1440,
    "height": 1406,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1441:9757",
    "name": "Contribution Monitoring loading state",
    "width": 1440,
    "height": 1406,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "1434:8784",
    "name": "Contribution confrimed payments",
    "width": 1440,
    "height": 1086,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "confirmed",
    "reference": "pending"
  },
  {
    "id": "1434:9052",
    "name": "Contribution payments Issue",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "issue",
    "reference": "pending"
  },
  {
    "id": "1434:9291",
    "name": "Contribution overdue payments",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "overdue",
    "reference": "pending"
  },
  {
    "id": "1434:9477",
    "name": "Contribution overdue payments",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "overdue",
    "reference": "pending"
  },
  {
    "id": "1434:9645",
    "name": "Contribution overdue payments",
    "width": 1440,
    "height": 1024,
    "section": "Opeyemi Hi-Fi",
    "route": "contributions",
    "state": "overdue",
    "reference": "pending"
  },
  {
    "id": "1568:3744",
    "name": "Member detail",
    "width": 402,
    "height": 1108,
    "section": "Opeyemi Hi-Fi",
    "route": "member-details",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "743:1060",
    "name": "Contribution Setup",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "contribution-setup",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "908:2146",
    "name": "Review Group Setup",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "review-group",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "743:1078",
    "name": "Group Rules",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "group-rules",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "743:1103",
    "name": "Payout Configuration",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "payout-configuration",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "743:1136",
    "name": "Success State",
    "width": 402,
    "height": 979,
    "section": "Cynthia's Hi-Fi",
    "route": "group-created",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "926:2585",
    "name": "Success State",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "group-created",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "1160:3356",
    "name": "Create Group",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "create-group",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1160:3376",
    "name": "Contribution setup",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "contribution-setup",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1198:2848",
    "name": "Group rules",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "group-rules",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1160:3432",
    "name": "Payout Configuration",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "payout-configuration",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1865:3865",
    "name": "Create Group",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "create-group",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1160:3452",
    "name": "Review Group setup",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "review-group",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1160:3488",
    "name": "Group Created",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "group-created",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1160:3511",
    "name": "Invite members",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "invite-members",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1788:3601",
    "name": "Success State",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "group-created",
    "state": "success",
    "reference": "pending"
  },
  {
    "id": "1959:4372",
    "name": "Desktop - 1",
    "width": 1440,
    "height": 1024,
    "section": "Cynthia's Hi-Fi",
    "route": "group-created",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1959:4374",
    "name": "Create Group",
    "width": 402,
    "height": 874,
    "section": "Cynthia's Hi-Fi",
    "route": "create-group",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "909:2271",
    "name": "Loading state",
    "width": 402,
    "height": 874,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "loading",
    "reference": "pending"
  },
  {
    "id": "909:2367",
    "name": "Empty state",
    "width": 402,
    "height": 874,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "empty",
    "reference": "pending"
  },
  {
    "id": "909:2441",
    "name": "Error state",
    "width": 402,
    "height": 874,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "error",
    "reference": "pending"
  },
  {
    "id": "925:2245",
    "name": "Payment submission detail",
    "width": 402,
    "height": 874,
    "section": "Adesewa's Hi fi",
    "route": "payment-review",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "936:2515",
    "name": "Modal evidence view page",
    "width": 360,
    "height": 335,
    "section": "Adesewa's Hi fi",
    "route": "view-evidence",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "977:3090",
    "name": "Payment review page",
    "width": 1440,
    "height": 1024,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "986:3553",
    "name": "empty state",
    "width": 1440,
    "height": 1024,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "empty",
    "reference": "pending"
  },
  {
    "id": "986:3628",
    "name": "empty state",
    "width": 1440,
    "height": 1024,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "empty",
    "reference": "pending"
  },
  {
    "id": "986:3721",
    "name": "empty state",
    "width": 1440,
    "height": 1024,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "empty",
    "reference": "pending"
  },
  {
    "id": "986:3803",
    "name": "Payment submissionn detail page",
    "width": 1440,
    "height": 1024,
    "section": "Adesewa's Hi fi",
    "route": "payment-review",
    "state": "default",
    "reference": "wireframe"
  },
  {
    "id": "1789:3590",
    "name": "Pending payment review",
    "width": 402,
    "height": 874,
    "section": "Adesewa's Hi fi",
    "route": "payment-reviews",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1898:3772",
    "name": "Confirm Payment Modal",
    "width": 368,
    "height": 335,
    "section": "Adesewa's Hi fi",
    "route": "confirm-payment",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1900:3788",
    "name": "Confirm Payment Modal",
    "width": 368,
    "height": 335,
    "section": "Adesewa's Hi fi",
    "route": "confirm-payment",
    "state": "default",
    "reference": "pending"
  },
  {
    "id": "1633:3432",
    "name": "Payout Schedule Screen",
    "section": "Wemimo HIFI",
    "width": 402,
    "height": 874,
    "route": "payouts",
    "state": "default",
    "reference": "saved"
  },
  {
    "id": "1680:3534",
    "name": "Payout Details Screen",
    "section": "Wemimo HIFI",
    "width": 402,
    "height": 874,
    "route": "payout-details",
    "state": "default",
    "reference": "saved"
  }
];

const e = escapeHtml;
const config = window.THRIFTCIRCLE_CONFIG;
const query = new URLSearchParams(location.search);
const preview =
  query.get("preview") === "1" ||
  location.pathname.endsWith("/preview.html") ||
  location.pathname.endsWith("/demo.html");
const app = document.getElementById("app");
const dialog = document.getElementById("modal");
let user = null;
let resetEmail = sessionStorage.getItem("thriftcircle.resetEmail") || "";
try {
  user = JSON.parse(sessionStorage.getItem("thriftcircle.user") || "null");
} catch {
  sessionStorage.removeItem("thriftcircle.user");
}
let role = query.get("role") === "member" ? "MEMBER" : "ORGANIZER";
if (preview)
  user = { name: role === "MEMBER" ? "Wemimo" : "Wemimo Opeyemi", role };
let data = preview
  ? fixtureData()
  : {
      groups: [],
      contributions: [],
      reviews: [],
      payouts: [],
      notifications: [],
      pending: [],
      issues: [],
      dashboard: {},
      cycle: {},
    };
let groupId =
  sessionStorage.getItem("thriftcircle.group") || (preview ? "family" : "");
let route = "";
let routeId = "";
let requestVersion = 0;
let busy = false;
let filter = "";
let search = "";
let groupDraft = {};
let evidenceDraft = {};
let receiptUrl = "";
let payoutDraft = null;
let ready = false;
let activeScreen = null;
let selectedMemberStatus = "ACTIVE";
let contributionTab = "";
let uploadedReturnRoute = "upload-evidence";

const api = createApi({
  baseUrl: config.apiBaseUrl,
  timeout: config.requestTimeout,
  getToken: () => sessionStorage.getItem("thriftcircle.token"),
  getRefreshToken: () => sessionStorage.getItem("thriftcircle.refreshToken"),
  onTokensRefreshed: (tokens) => {
    sessionStorage.setItem("thriftcircle.token", tokens.accessToken);
    sessionStorage.setItem("thriftcircle.refreshToken", tokens.refreshToken);
  },
  onUnauthorized: () => {
    sessionStorage.removeItem("thriftcircle.token");
    sessionStorage.removeItem("thriftcircle.refreshToken");
    sessionStorage.removeItem("thriftcircle.user");
    user = null;
  },
});
const iconNames = {
  dashboard: "dash",
  contributions: "contrib",
  notifications: "activity",
  eye: "userround",
  bank: "payouts",
  account: "profile",
  receipt: "contrib",
  arrow: "chevronright",
  back: "arrowleft",
  home: "home",
};
const dimensions = {
  dash: [18, 18],
  groups: [18, 18],
  contrib: [18, 18],
  members: [18, 18],
  payouts: [18, 18],
  history: [18, 18],
  bell: [36, 36],
  users: [20, 20],
  chevrondown: [20, 24],
  calendar: [20, 20],
  check: [32, 32],
  info: [24, 24],
  home: [20, 20],
  activity: [20, 20],
  profile: [20, 20],
  chevronright: [24, 24],
  arrowleft: [24, 24],
  userround: [36, 36],
  copy: [24, 24],
  search: [35, 35],
};
function icon(name, extra = "") {
  name = iconNames[name] || name;
  const [w, h] = dimensions[name] || [20, 20];
  return `<span class="icon ${extra}" aria-hidden="true" style="width:${w}px;height:${h}px"><img src="./assets/${name}.svg" alt="" width="${w}" height="${h}"></span>`;
}
const logo =
  '<img class="logo" src="./assets/asset-1.png" width="174" height="58" alt="ThriftCircle">';
const href = (name, id = "") =>
  `#${name}${id ? "/" + encodeURIComponent(id) : ""}`;
const link = (name, label, cls = "", id = "") =>
  `<a class="${cls}" href="${href(name, id)}">${label}</a>`;
const button = (label, action, cls = "", attrs = "") =>
  `<button type="button" class="btn ${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const avatar = (name, cls = "") =>
  `<span class="avatar ${cls}">${e(initials(name))}</span>`;
const title = (heading, description = "") =>
  `<div class="page-title"><div class="page-heading">${["upload-evidence", "update-submission", "review-submission", "review-resubmit", "contribution-details", "payment-instructions", "correction-required"].includes(route) ? link(route === "review-submission" || route === "review-resubmit" ? "upload-evidence" : "contribution-details", icon("back"), "mobile-back") : ""}<h1>${e(heading)}</h1></div>${description ? `<p>${e(description)}</p>` : ""}</div>`;
const field = (
  label,
  name,
  type = "text",
  placeholder = "",
  value = "",
  attrs = "",
) =>
  `<label class="field"><strong>${e(label)}</strong><input name="${name}" type="${type}" placeholder="${e(placeholder)}" value="${e(value)}" ${attrs}></label>`;
const select = (label, name, choices, value = "", attrs = "") =>
  `<label class="field"><strong>${e(label)}</strong><select name="${name}" ${attrs}>${choices.map(([v, t]) => `<option value="${e(v)}" ${String(v) === String(value) ? "selected" : ""}>${e(t)}</option>`).join("")}</select></label>`;
const formError = '<p class="form-error" role="alert"></p>';
const group = () =>
  data.groups.find((g) => idOf(g) === groupId) || data.groups[0];
const memberName = (value) =>
  value?.fullName || value?.name || value?.email || "Member";
const currentContribution = () =>
  data.contributions.find((c) => idOf(c) === routeId) ||
  data.contributions.find(
    (c) => (c.groupId === groupId || !c.groupId) && ["DUE", "OVERDUE", "ISSUE"].includes(c.status),
  ) ||
  data.contributions.find((c) => c.groupId === groupId || !c.groupId);
function pill(status) {
  const key = String(status || "").toUpperCase();
  const labels = {
    CONFIRMED: "Confirmed",
    APPROVED: "Confirmed",
    DUE: "Due",
    COMPLETED: "Completed",
    UNDER_REVIEW: "Under Review",
    PENDING_REVIEW: "Awaiting Review",
    PENDING: "Pending",
    PENDING_APPROVAL: "Due Today",
    ACTIVE: "Active Cycle",
    INACTIVE: "Inactive Cycle",
    CORRECTION_REQUIRED: "Correction Required",
    OVERDUE: "Overdue",
    UPCOMING: "Upcoming",
    PAYOUT_PHASE: "Payout Phase",
  };
  const color =
    /CONFIRMED|APPROVED|COMPLETED|ACTIVE/.test(key) && key !== "INACTIVE"
      ? "green"
      : /DUE|PENDING/.test(key)
        ? "amber"
        : /UNDER_REVIEW/.test(key)
          ? "blue"
          : /REJECTED|CORRECTION|OVERDUE/.test(key)
            ? "red"
            : "";
  return `<span class="pill ${color}">${e(labels[key] || status || "Upcoming")}</span>`;
}
function details(rows) {
  return `<dl class="details">${rows.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
function empty(heading, description, action = "") {
  return `<div class="empty card">${title(heading, description)}${action}</div>`;
}
function notify(message) {
  const el = document.getElementById("feedback");
  el.textContent = message;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 4000);
}
function go(name, id = "") {
  const target = href(name, id);
  if (location.hash === target) render();
  else location.hash = target;
}
function previewNotice() {
  return preview && query.get("present") !== "1"
    ? '<div class="preview-banner">Design preview · Sample data · No backend changes are made. <a href="./index.html">Open live sign-in</a></div>'
    : "";
}
function passwordField(label, name, placeholder, min = 8) {
  return `<label class="field"><span>${e(label)}</span><span class="password"><input type="password" name="${name}" placeholder="${e(placeholder)}" required minlength="${min}" autocomplete="${name === "password" && route === "login" ? "current-password" : "new-password"}"><button type="button" class="icon-btn" data-action="password" aria-label="Show password">${icon("profile")}</button></span></label>`;
}
function authLayout(content, image, cls = "", back = true) {
  return `${previewNotice()}<section class="auth ${cls}"><div class="auth-left"><div class="auth-head">${logo}${back ? link(route === "signup" ? "role" : "welcome", `${icon("back")}Back`, "back") : ""}</div><div class="auth-body">${content}</div></div><div class="auth-right"><img src="./assets/asset-${image}.png" alt="" width="${[626, 174, 174, 562, 596, 547, 582, 581][image]}" height="${[626, 58, 58, 670, 606, 527, 450, 481][image]}"></div></section>`;
}
function welcome() {
  return authLayout(
    `<h1><span class="green-title">Save Together</span><br><span class="orange-title">Grow Together</span></h1><p class="lead">Create or join trusted savings groups, track contributions, and stay on top of every cycle.</p><div class="welcome-actions">${link("role", "Get Started", "btn")}${link("login", "Log In", "btn secondary")}</div>`,
    0,
    "welcome",
    false,
  );
}
function chooseRole() {
  return authLayout(
    `<h1>Choose a role</h1><p class="lead">Select how you want to use ThriftCircle.</p><form id="role-form" class="role-options"><label class="role-card"><span class="avatar">${icon("users")}</span><div><h2>Organizer</h2><p>Create and manage savings groups, invite members, and track contributions.</p></div><input type="radio" name="role" value="ORGANIZER" ${activeScreen?.state === "organizer" ? "checked" : ""} required></label><label class="role-card"><span class="avatar">${icon("profile")}</span><div><h2>Member</h2><p>Join a savings group, make contributions, and track your progress.</p></div><input type="radio" name="role" value="MEMBER" ${activeScreen?.state === "member" ? "checked" : ""} required></label>${formError}<button class="btn block" type="submit" >Continue</button></form>`,
    3,
  );
}
function login() {
  return authLayout(
    `<h1>Welcome back</h1><p class="lead">Log in to your ThriftCircle account.</p><form id="login-form" class="auth-form">${field("Email or Phone Number", "loginIdentifier", "text", "Enter your email or phone number", "", 'required autocomplete="username"')}${passwordField("Password", "password", "Enter password", 1)}${link("forgot-password", "Forgot Password?", "forgot-link")}${formError}<button class="btn block" type="submit">Log in</button></form><p class="auth-foot">Don’t have an account? ${link("role", "Sign Up")}</p>`,
    5,
  );
}
function signup() {
  return authLayout(
    `<h1>Create your account</h1><p class="lead">Set up your ThriftCircle account to get started.</p><form id="signup-form" class="auth-form">${field("Full Name", "fullName", "text", "Enter your full name", "", 'required autocomplete="name"')}${field("Email Address", "email", "email", "Enter your email address", "", 'required autocomplete="email"')}${field("Phone Number", "phoneNumber", "tel", "Enter your phone number", "", 'required autocomplete="tel"')}${passwordField("Password", "password", "Enter password")}${passwordField("Confirm Password", "confirmPassword", "Confirm password")}<label class="check-label"><input type="checkbox" name="terms" required><span>I agree to the <button type="button" class="text-btn" data-action="legal" data-kind="terms">Terms of Service</button> and <button type="button" class="text-btn" data-action="legal" data-kind="privacy">Privacy Policy</button></span></label>${formError}<button class="btn block" type="submit">Create Account</button><p style="text-align:center">Already have an account? ${link("login", "Log In")}</p></form>`,
    4,
    "signup",
  );
}
function forgot() {
  return authLayout(
    `<h1>Forgot Password?</h1><p class="lead">Enter the email linked to your account to request a password reset code.</p><form id="forgot-form" class="auth-form">${field("Email Address", "email", "email", "Enter your email address", "", 'required autocomplete="email"')}${formError}<button class="btn block" type="submit">Request Reset Code</button></form>`,
    6,
  );
}
function reset() {
  return authLayout(
    `<h1>Reset Password</h1><p class="lead">Enter the reset code and create a new password.</p><form id="reset-form" class="auth-form">${field("Account Email", "email", "email", "Enter your email address", resetEmail, 'required autocomplete="email"')}${field("Reset Code", "resetCode", "text", "Enter the 6-digit code", "", 'required inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}${passwordField("New Password", "password", "Enter password")}${passwordField("Confirm New Password", "confirmPassword", "Confirm new password")}<p class="small muted">Use at least 8 characters</p>${formError}<button class="btn block" type="submit">Reset Password</button></form>`,
    7,
  );
}
function shell(content) {
  const wizard =
    /^create-group|contribution-setup|group-rules|payout-configuration|review-group|group-created|invite-members/.test(
      route,
    );
  const reviewPage = /payment-review/.test(route);
  document.body.className = wizard
    ? "wizard"
    : reviewPage
      ? "payment-reviews"
      : user?.role === "MEMBER"
        ? "member-layout"
        : route === "members"
          ? "member-list-layout"
          : "";
  const nav =
    user?.role === "MEMBER"
      ? [
          ["dashboard", "Dashboard"],
          ["groups", "Groups"],
          ["contributions", "Contributions"],
          ["profile", "Profile"],
        ]
      : [
          ["dashboard", "Dashboard"],
          ["groups", "Groups"],
          ["contributions", "Contributions"],
          ["members", "Members"],
          ["payouts", "Payouts"],
          ["history", "History"],
        ];
  const active = /group|invite|contribution-setup|payout-configuration/.test(
    route,
  )
    ? "groups"
    : /payment|contribution|evidence|instructions|correction/.test(route)
      ? "contributions"
      : /payout/.test(route)
        ? "payouts"
        : /member/.test(route)
          ? "members"
          : route;
  const displayName = preview && wizard ? "Cynthia" : memberName(user);
  return `${previewNotice()}<div class="shell"><aside class="sidebar">${link("dashboard", logo)}<nav aria-label="Main navigation">${nav.map(([name, label]) => link(name, `${icon(name)}${label}`, `nav-link ${active === name ? "active" : ""}`)).join("")}</nav></aside><div class="workspace"><header class="topbar"><img class="toolbar-mobile" src="./assets/asset-1.png" width="120" height="40" alt="ThriftCircle"><div class="search-box">${icon("search")}<input type="search" placeholder="${wizard ? "Search" : "Search contributions"}" aria-label="Search contributions" id="global-search"></div><div class="row"><a class="icon-btn" href="#notifications" aria-label="Notifications">${icon("bell")}</a>${link("profile", `<span class="row">${preview && wizard ? '<span class="avatar small-avatar"><img src="./assets/cynthia.png" alt=""></span>' : avatar(displayName, "small-avatar")}<span><span class="user-name">${e(displayName)}</span><span class="user-role" style="display:block">${user?.role === "MEMBER" ? "Member" : "Organizer"}</span></span></span>`, "user-link")}</div></header><div class="content">${preview && query.get("present") !== "1" ? '<a class="preview-index-link" href="#screens">All screens</a>' : ""}${content}</div></div></div><nav class="mobile-nav" aria-label="Mobile navigation">${[
    ["dashboard", "Home", "home"],
    ["groups", "Groups", "groups"],
    ["contributions", "Contributions", "contrib"],
    ["notifications", "Activity", "activity"],
    ["profile", "Profile", "profile"],
  ]
    .map(([name, label, image]) =>
      link(name, `${icon(image)}${label}`, active === name ? "active" : ""),
    )
    .join("")}</nav>`;
}
function cycleBar() {
  const c = data.cycle || {};
  const cycleNumber = c.cycleNumber ?? c.number;
  const label = c.name || (cycleNumber ? `Cycle ${cycleNumber}` : "No active cycle");
  const groupOptions = data.groups.map((g) => `<option value="${e(idOf(g))}" ${idOf(g) === groupId ? "selected" : ""}>${e(preview && idOf(g) === "family" ? "My Family Ajo" : g.name)}</option>`).join("");
  if (user?.role === "MEMBER") {
    return `<section class="member-cycle-row"><div class="member-current-cycle"><span>Current cycle</span><strong>${e(label)}</strong></div><div class="member-cycle-controls"><label class="member-select-wrap"><span class="sr-only">Savings group</span><select id="group-select" aria-label="Savings group">${groupOptions}</select></label><label class="member-select-wrap"><span class="sr-only">Cycle or week</span><select aria-label="Current cycle" disabled title="Cycle history is not available yet"><option>${e(cycleNumber ? `Cycle ${cycleNumber}` : "No active cycle")}</option></select></label></div></section>`;
  }
  return `<div class="cycle-bar"><div><h3 class="muted">Current Cycle</h3><strong class="small">${e(label === "No active cycle" ? "Current Cycle" : label)}</strong></div><div class="cycle-selector"><select id="group-select" aria-label="Savings group">${groupOptions}</select><span class="row small">${icon("calendar")} ${e(cycleNumber ? `Cycle ${cycleNumber}` : c.status || "Waiting for member approval")}</span></div></div>`;
}
function recentPayments(history = false) {
  const g = group();
  const memberId = idOf(user) || idOf(data.dashboard?.currentContribution?.memberId) || idOf(data.dashboard?.currentContribution?.member);
  const rows = data.contributions
    .filter((c) => !g || c.groupId === idOf(g) || !c.groupId)
    .filter((c) => user?.role !== "MEMBER" || preview || (memberId && idOf(c.member) === memberId))
    .filter((c) => /CONFIRMED|APPROVED/.test(c.status || ""));
  return `<section class="member-payments"><div class="section-head"><h3>${history ? "Contribution History" : "Recent Payments"}</h3>${history ? "" : link("history", "View Contribution History", "small", "")}</div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Status</th>${history ? "<th>Actions</th>" : ""}</tr></thead><tbody>${rows.map((c) => `<tr><td>${e(formatDate(c.confirmedAt || c.submittedAt || c.paymentDate || c.createdAt))}</td><td class="amount">${money(c.amount)}</td><td>${pill(c.status)}</td>${history ? `<td>${link("contribution-details", "View", "text-btn", idOf(c))}</td>` : ""}</tr>`).join("") || `<tr><td colspan="${history ? 4 : 3}" class="member-table-empty">No confirmed payments yet.</td></tr>`}</tbody></table></div></section>`;
}
function memberDashboard(g) {
  const current = data.dashboard?.currentContribution || (preview ? data.contributions.find((c) => c.groupId === idOf(g) && ["DUE", "OVERDUE", "PENDING_REVIEW"].includes(c.status)) : null);
  const firstName = memberName(user).split(/\s+/)[0];
  const cycleStatus = String(data.cycle?.status || "").toUpperCase();
  const cycleBadge = cycleStatus === "ACTIVE" || cycleStatus === "PAYOUT_PHASE" || (preview && g.status === "ACTIVE")
    ? '<span class="member-active-badge"><i></i>Active</span>'
    : '<span class="member-active-badge inactive"><i></i>No active cycle</span>';
  const dueDate = current?.dueDate || current?.paymentDate;
  const position = Number(data.dashboard?.payoutOrder);
  const total = Number(data.dashboard?.cycleProgress?.total || g.members?.filter((m) => m.status === "ACTIVE").length || 0);
  const hasPosition = Number.isInteger(position) && position > 0 && total > 0;
  const segments = hasPosition
    ? Array.from({ length: Math.min(total, 30) }, (_, index) => `<span class="${index < position ? "reached" : ""}" aria-hidden="true"></span>`).join("")
    : "";
  const amount = current?.amount;
  const amountDue = Number.isFinite(Number(amount)) && amount !== null && amount !== undefined ? money(amount) : "—";
  const memberAmount = Number.isFinite(Number(g.contributionAmount)) && g.contributionAmount !== null && g.contributionAmount !== undefined ? money(g.contributionAmount) : "—";
  return `<div class="member-dashboard-heading"><div><h1>Good morning, ${e(firstName)}</h1><p>Here’s what’s happening with your savings group.</p></div>${cycleBadge}</div>${cycleBar()}<div class="member-dashboard-grid"><section class="member-contribution-card"><div class="member-card-heading"><div><span class="member-eyebrow">Next contribution</span><h2>${current ? amountDue : "No outstanding contribution"}</h2></div><span class="member-group-name">${e(g.name)}</span></div><div class="member-contribution-meta"><div><span>Amount</span><strong>${current ? amountDue : "—"}</strong></div><div><span>Due date</span><strong>${current ? e(formatDate(dueDate)) : "Not scheduled"}</strong></div></div><div class="member-dashboard-actions">${link("outstanding-contribution", "View Outstanding Contribution", "btn secondary")}${link("contributions", "Make Contributions", "btn")}</div></section><section class="member-position-card"><div class="member-card-heading"><div><span class="member-eyebrow">Your position in cycle</span><h2>${hasPosition ? `${position} of ${total}` : "Position unavailable"}</h2></div></div><div class="member-position-track" role="img" aria-label="${hasPosition ? `Position ${position} of ${total}` : "Cycle position unavailable"}">${segments || '<span class="member-position-empty">Position will appear when the cycle is active.</span>'}</div><div class="member-position-meta"><div><span>Expected payout date</span><strong>Not scheduled</strong></div><div><span>Amount per member</span><strong>${memberAmount}</strong></div></div></section></div>${recentPayments()}`;
}
function dashboard() {
  const g = group();
  if (!g)
    return empty(
      "No savings groups yet",
      "Create or join a group to get started.",
      link(
        user?.role === "MEMBER" ? "join-group" : "create-group",
        user?.role === "MEMBER" ? "Join Group" : "Create Group",
        "btn",
      ),
    );
  if (user?.role === "MEMBER") return memberDashboard(g);
  const d = data.dashboard || {};
  const counts = [
    ["Confirmed", d.confirmed ?? 0, "", "Payments received from members."],
    ["Pending", d.pending ?? 0, "amber", "Payments awaiting review"],
    ["Overdue", d.overdue ?? 0, "red", "Overdue contributions need attention."],
    [
      "Member",
      d.totalMembers ?? (g.members || []).length,
      "blue",
      "Total members in the group",
    ],
  ];
  return `<div class="row between"><div>${title(`Good morning, ${preview ? "Opeyemi" : memberName(user).split(" ")[0]}`, "Here is what’s happening with your savings group.")}</div>${pill(data.cycle?.status || "ACTIVE")}</div>${cycleBar()}<section><h1 style="margin-bottom:16px">Contribution Summary</h1><div class="stat-grid">${counts.map(([label, number, cls, desc]) => `<div class="stat ${cls}"><h3>${number} ${label}</h3><p>${desc}</p></div>`).join("")}</div></section><div class="dashboard-panels"><div class="card attention"><h3>Needs your attention</h3>${[
    ["payment-reviews", `${d.pending ?? 0} payment await review`],
    ["contributions", `${d.overdue ?? 0} Overdue contribution`],
    ["pending-members", "Pending payments"],
    ["payouts", "Payout Position"],
  ]
    .map(([page, label]) => link(page, `${e(label)}${icon("arrow")}`))
    .join(
      "",
    )}</div><div class="card"><h3>${icon("calendar")} Upcoming Deadlines</h3>${
    (preview
      ? [
          ["Today", "August, 22nd 2026"],
          ["Tomorrow", "August, 23rd 2026"],
        ]
      : (data.cycle?.deadlines || []).map((x) => ["", formatDate(x.date)])
    )
      .map(
        ([label, date]) =>
          `<div class="list-row"><span class="pill">${label}</span><div class="grow"><p class="small">${e(date)}</p><small>${preview ? 3 : ""} contributions due</small></div>${icon("arrow")}</div>`,
      )
      .join("") ||
    '<p class="small muted" style="margin-top:24px">No upcoming deadlines.</p>'
  }<p style="text-align:right;margin-top:18px">${link("contributions", "View all", "small")}</p></div><div class="card"><h3>Contribution Breakdown</h3><div class="donut-wrap"><div class="donut" style="background:conic-gradient(#007f5f 0 ${(Number(d.confirmed || 0) / Math.max(1, Number(d.totalMembers || 1))) * 100}%,#ffc107 0 90%,#c51d24 0)"><span>${d.confirmed || 0}/${d.totalMembers || 0}</span></div><p style="text-align:center"><strong>${money(d.collected)}</strong><br><span class="small">out of<br>${money(d.target)}</span></p></div><div class="legend">${[
    ["Confirmed", d.confirmed || 0, ""],
    ["Pending Verification", d.pending || 0, "amber"],
    ["Overdue", d.overdue || 0, "red"],
    ["Total Member", d.totalMembers || 0, "blue"],
  ]
    .map(
      ([text, value, color]) =>
        `<div><span><i class="dot ${color}"></i>${text}</span><span>${value}</span></div>`,
    )
    .join(
      "",
    )}</div></div></div><section class="card activity-list"><div class="section-head"><h3>Recent Activities</h3>${link("notifications", "View all")}</div>${
    data.notifications
      .slice(0, 4)
      .map(
        (n, i) =>
          `<div class="list-row">${avatar(preview ? ["Ada", "Michael", "Chidi", "Payout"][i] : "Activity")}<p class="grow muted">${e(n.message)}</p><span class="time">${preview ? ["2 mins ago", "1 hour ago", "2 hours ago", "Yesterday"][i] : e(formatDate(n.createdAt))}</span></div>`,
      )
      .join("") || '<p class="muted">No recent activities.</p>'
  }</section>`;
}
function groups() {
  return `<div class="row between">${title("Groups", "View and manage your savings groups.")}<div class="pending-actions">${link("join-group", "Join Group", "btn secondary")}${user?.role !== "MEMBER" ? link("create-group", "Create Group", "btn") : ""}</div></div><div class="group-grid">${
    data.groups
      .map(
        (g) =>
          `<section class="card group-card"><div class="row between"><h2>${e(g.name)}</h2>${pill(g.status)}</div><p class="muted">${e("")}</p>${details(
            [
              ["Contribution amount", money(g.contributionAmount)],
              ["Members", e(g.memberCount || (g.members || []).length)],
              ["Frequency", e(g.frequency || "—")],
            ],
          )}${link("group-details", "View Group", "btn secondary block", idOf(g))}</section>`,
      )
      .join("") ||
    empty("No groups yet", "Join or create your first savings group.")
  }</div>`;
}
function groupDetails() {
  const g = group();
  if (!g)
    return empty(
      "Group not found",
      "Select a savings group.",
      link("groups", "Back to Groups", "btn"),
    );
  return `${title(g.name, "")}${cycleBar()}<div class="grid"><section class="card stack"><h2>Group Details</h2>${details(
    [
      ["Members", e(g.memberCount || (g.members || []).length)],
      ["Contribution Amount", money(g.contributionAmount)],
      ["Frequency", e(g.frequency)],
    ],
  )}</section><section class="card stack"><h2>Group Rules</h2>${details([
    ["Grace Period", `${Number(data.rules?.gracePeriodDays ?? 0)} days`],
    ["Late Evidence", data.rules?.allowLateSubmission === false ? "Not allowed" : "Allowed"],
    ["Member Limit", data.rules?.maxMembers ?? "No limit"],
  ])}</section></div><div class="pending-actions">${link("contributions", "View Contributions", "btn")}${link("payouts", "Payout Schedule", "btn secondary")}${user?.role !== "MEMBER" ? link("invite-members", "Invite Members", "btn secondary") + link("pending-members", "Pending Requests", "btn secondary") : ""}</div>`;
}
function wizardActions(label = "Continue") {
  return `<div class="wizard-actions"><button class="btn" type="submit">${label}</button></div>`;
}
function createGroup() {
  return `${title("Create a New Group", "Set up your savings group and the account members should pay into.")}<form id="create-group-form"><div class="grid form-grid">${field("Group Name", "name", "text", "e.g. Family Savings Circle", groupDraft.name, 'required maxlength="100"')}${select("Member Limit", "memberCount", [["", "Choose a member limit"], ...[3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30].map((n) => [n, n + " members"])], groupDraft.memberCount, "required")}${field("Bank Name", "bankName", "text", "e.g. Access Bank", groupDraft.bankName, 'required maxlength="100"')}${field("Account Name", "accountName", "text", "Name on the bank account", groupDraft.accountName, 'required maxlength="100"')}${field("Account Number", "accountNumber", "text", "Enter 10-digit account number", groupDraft.accountNumber, 'required inputmode="numeric" pattern="[0-9]{10}" maxlength="10"')}${field("Payment Reference (optional)", "reference", "text", "e.g. Group name and contribution month", groupDraft.reference, 'maxlength="100"')}</div>${formError}${wizardActions()}</form>`;
}
function contributionSetup() {
  return `${title("Contribution Setup", "Define how and when members will contribute.")}<form id="contribution-setup-form"><div class="grid form-grid">${field("Contribution amount", "contributionAmount", "number", "e.g. ₦50,000", groupDraft.contributionAmount, 'required min="1" step="0.01"')}${select(
    "Contribution frequency",
    "frequency",
    [
      ["", "Select frequency"],
      ["WEEKLY", "Weekly"],
      ["MONTHLY", "Monthly"],
    ],
    groupDraft.frequency,
    "required",
  )}${field("Contribution Start Date", "startDate", "date", "", groupDraft.startDate, "required")}${field("Contribution Deadline", "contributionDeadline", "date", "", groupDraft.contributionDeadline, "required")}</div>${formError}${wizardActions()}</form>`;
}
function groupRules() {
  return `${title("Group Rules", "Set the payment grace period and late submission policy.")}<form id="group-rules-form"><div class="rules-grid">${select(
    "Grace Period",
    "gracePeriodDays",
    [[0, "No grace period"], [3, "3 days"], [5, "5 days"], [7, "7 days"]],
    groupDraft.gracePeriodDays ?? 0,
  )}${select(
    "Late Payment Evidence",
    "allowLateSubmission",
    [["true", "Allow late submission"], ["false", "Do not allow late submission"]],
    String(groupDraft.allowLateSubmission ?? true),
  )}</div>${formError}${wizardActions()}</form>`;
}
function payoutConfig() {
  return `${title("Payout Configuration", "Choose how payout turns will be arranged and when each payout will be recorded.")}<form id="payout-config-form"><p>How will members payout turns be decided?</p><div class="choice-grid">${[
    ["ORGANIZER_ASSIGNED", "Organiser assigns after member joins"],
    ["JOIN_ORDER", "Order of joining"],
    ["RANDOM", "Random Order"],
  ]
    .map(
      ([v, label]) =>
        `<label><input type="radio" name="payoutMethod" value="${v}" ${(groupDraft.payoutMethod || "ORGANIZER_ASSIGNED") === v ? "checked" : ""}>${label}</label>`,
    )
    .join(
      "",
    )}</div><h1>Payout approval</h1><div class="note green">${icon("info")}<div><p>Payouts can proceed even if a member defaults.</p><p class="muted" style="margin-top:12px">The organiser can review the confirmed contributions and approve the payout.</p></div></div>${formError}${wizardActions()}</form>`;
}
function reviewGroup() {
  const cards = [
    [
      "Group Details",
      "create-group",
      `${e(groupDraft.name)}<br>Member limit: ${e(groupDraft.memberCount)}<br>Bank: ${e(groupDraft.bankName)}<br>Account name: ${e(groupDraft.accountName)}<br>Account number: ${e(groupDraft.accountNumber)}`,
      "groups",
    ],
    [
      "Contribution Setup",
      "contribution-setup",
      `${money(groupDraft.contributionAmount)}<br>${e(groupDraft.frequency)}<br>Starts ${e(formatDate(groupDraft.startDate))}<br>Deadline ${e(formatDate(groupDraft.contributionDeadline))}`,
      "calendar",
    ],
    ["Group Rules", "group-rules", `${groupDraft.gracePeriodDays ?? 0} grace days; late evidence ${groupDraft.allowLateSubmission === false ? "disabled" : "allowed"}`, "info"],
  ];
  return `${title("Review Group Setup", "Please review your group details before creating it. You can edit any section if needed.")}<form id="review-group-form"><div class="grid setup-review">${cards.map(([heading, page, text, image]) => `<section class="card"><span class="avatar">${icon(image)}</span><div class="grow"><h3>${heading}</h3><p>${text}</p></div>${link(page, "Edit")}</section>`).join("")}</div>${formError}${wizardActions("Create Group")}</form>`;
}
function groupCreated() {
  return `<div class="narrow stack" style="text-align:center;padding-top:48px"><span style="margin:auto">${icon("check")}</span>${title("Group Created", "Your savings group is ready. Invite members to get started.")}<section class="card">${details(
    [
      ["Group Name", e(group()?.name)],
      ["Group Code", e(group()?.inviteCode || "—")],
    ],
  )}</section>${link("invite-members", "Invite Members", "btn block")}${link("dashboard", "Back to Dashboard", "btn secondary block")}</div>`;
}
function invite() {
  const g = group();
  if (!g)
    return empty(
      "No group selected",
      "Select a group to invite members.",
      link("groups", "Groups", "btn"),
    );
  const code = g.inviteCode || g.code || "";
  const inviteLink =
    g.inviteLink ||
    `${location.origin}${location.pathname}${preview ? "?preview=1" : ""}#join-group/${encodeURIComponent(code)}`;
  return `${title("Invite Members", "Share your group code and link so others can join your savings group.")}<div class="grid"><div class="stack"><strong>Group Code</strong><div class="code-box">${icon("groups")}<code>${e(code || "—")}</code>${button("Copy", "copy", "compact", `data-copy="${e(code)}" ${code ? "" : "disabled"}`)}</div></div><div class="stack"><strong>Invite Link</strong><div class="code-box">${icon("copy")}<code>${e(inviteLink)}</code>${button("Copy", "copy", "compact", `data-copy="${e(inviteLink)}"`)}</div></div></div><div class="share-section"><h3>Share via</h3><div class="share-icons">${button("Whatsapp", "share-whatsapp", "secondary", `data-copy="${e(inviteLink)}"`)}${button("Telegram", "share-telegram", "secondary", `data-copy="${e(inviteLink)}"`)}${button("More", "share", "secondary", `data-copy="${e(inviteLink)}"`)}</div>${button("Share invite", "share", "", `data-copy="${e(inviteLink)}"`)}<div class="note green"><div><h3>Require approval</h3><p class="small">People who use your link or code must be approved by you before they join.</p></div></div>${link("groups", "Done", "btn secondary block")}</div>`;
}
function joinGroup() {
  return `<div class="narrow stack">${title("Join a Group", "Enter the group code shared by your organizer.")}<form id="join-group-form" class="stack">${field("Group Code", "inviteCode", "text", "Enter group code", routeId, "required")}${formError}<button class="btn block">Join Group</button></form></div>`;
}
function members() {
  const all = group()?.members || [];
  const rows = all.filter(
    (m) =>
      (!filter || m.status === filter) &&
      `${memberName(m)} ${m.phoneNumber || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return `<div class="row between">${title("Member List", "View and manage members details")}${link("invite-members", "Add new member", "btn")}</div>${cycleBar()}<div class="member-stat-grid">${[
    ["Total Members", all.length, "#1d4ed8"],
    [
      "Active Members",
      all.filter((m) => m.status === "ACTIVE").length,
      "#047857",
    ],
    [
      "Removed Members",
      all.filter((m) => m.status === "REMOVED").length,
      "#4b5563",
    ],
  ]
    .map(
      ([label, n, color]) =>
        `<div class="card" style="color:${color}"><strong>${n}</strong>${label}</div>`,
    )
    .join(
      "",
    )}</div><section class="card"><div class="filters"><div class="search-box">${icon("search")}<input id="list-search" type="search" value="${e(search)}" placeholder="Search member by name or phone number........" aria-label="Search members"></div><select id="status-filter" aria-label="Membership status"><option value="">All Status</option><option value="ACTIVE" ${filter === "ACTIVE" ? "selected" : ""}>Active Members</option><option value="REMOVED" ${filter === "REMOVED" ? "selected" : ""}>Removed Members</option></select>${link("pending-members", "Pending requests", "btn secondary compact")}</div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Phone Number</th><th>Membership Status</th><th>Date Joined</th><th>Contribution Position</th><th>Actions</th></tr></thead><tbody>${rows.map((m, i) => `<tr><td><strong>${e(memberName(m))}</strong></td><td>${e(m.phoneNumber || "—")}</td><td>${pill(m.status)}</td><td>${e(formatDate(m.joinedAt))}</td><td>${m.position || i + 1} of ${all.length}</td><td>${link("member-details", "View", "btn secondary compact", idOf(m))}</td></tr>`).join("") || '<tr><td colspan="6">No matching members.</td></tr>'}</tbody></table></div><div class="pagination">Showing ${rows.length ? "1" : "0"}–${rows.length} of ${all.length} members</div></section>`;
}
function legacyMemberDetails() {
  const m = (group()?.members || []).find((m) => idOf(m) === routeId);
  if (!m)
    return empty(
      "Member not found",
      "Choose a member from the list.",
      link("members", "Member List", "btn"),
    );
  return `${title("Member Details")}<section class="card narrow stack"><div class="row">${avatar(memberName(m))}<div><h2>${e(memberName(m))}</h2>${pill(m.status)}</div></div>${details(
    [
      ["Phone Number", e(m.phoneNumber || "—")],
      ["Date Joined", e(formatDate(m.joinedAt))],
      ["Contribution Position", e(m.position || "—")],
    ],
  )}${link("members", "Back to Member List", "btn secondary block")}</section>`;
}
function pendingMembers() {
  return `${title("Pending Member Requests", "Review requests to join your savings group.")}<div class="stack">${data.pending.map((m) => `<section class="card row">${avatar(memberName(m))}<div style="flex:1"><h3>${e(memberName(m))}</h3><p class="muted">${e(m.phoneNumber || "")}</p></div><div class="pending-actions">${button("Approve", "approve-member", "", `data-id="${e(idOf(m))}"`)}${button("Reject", "reject-member", "secondary", `data-id="${e(idOf(m))}"`)}</div></section>`).join("") || empty("No pending requests", "New membership requests will appear here.")}</div>`;
}
function legacyContributions() {
  if (user?.role === "MEMBER")
    return `${title("Contributions")}<div class="pending-actions">${link("contribution-details", "Contribution Details", "btn")}${link("history", "Contribution History", "btn secondary")}</div>${recentPayments(true)}`;
  const rows = data.contributions.filter(
    (c) =>
      (c.groupId === groupId || !c.groupId) &&
      (!filter || c.status === filter) &&
      `${memberName(c.member)} ${c.reference || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return `${title("Contribution Monitoring", "View and track members contributions.")}${cycleBar()}<div class="row between">${link("payment-reviews", "Pending Payment Reviews", "btn")}${link("issues", "Pending Issues", "btn secondary")}</div><section class="card"><div class="filters"><div class="search-box">${icon("search")}<input id="list-search" type="search" value="${e(search)}" placeholder="Search contributions" aria-label="Search contributions"></div><select id="status-filter" aria-label="Contribution status">${[
    ["", "All Status"],
    ["CONFIRMED", "Confirmed"],
    ["UNDER_REVIEW", "Under Review"],
    ["OVERDUE", "Overdue"],
    ["DUE", "Due"],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}" ${filter === v ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Amount</th><th>Payment Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map((c) => `<tr><td>${e(memberName(c.member))}</td><td>${money(c.amount)}</td><td>${e(formatDate(c.paymentDate))}</td><td>${pill(c.status)}</td><td>${link("contribution-details", "View", "text-btn", idOf(c))}</td></tr>`).join("") || '<tr><td colspan="5">No matching contributions.</td></tr>'}</tbody></table></div></section>`;
}
function recentContributions() {
  const cs = data.contributions.filter(
    (c) => c.status === "CONFIRMED" && (c.groupId === groupId || !c.groupId),
  );
  return `<section class="contribution-recent recent-block"><div class="section-head"><h3>Recent Contributions</h3>${link("history", `View All ${icon("arrow")}`)}</div>${cs.map((c) => `<a href="${href("contribution-details", idOf(c))}" class="list-row" style="color:inherit">${avatar("Family Group")}<span class="grow"><strong>${e(c.cycle || formatDate(c.paymentDate))}</strong><small>${e(formatDate(c.paymentDate))}</small></span><strong class="amount">${money(c.amount)}</strong>${pill(c.status)}</a>`).join("") || '<p class="muted">No recent contributions.</p>'}</section>`;
}
function bankDetails() {
  const g = group() || {};
  return `<div class="card">${[
    ["bank", "Bank", g.bankName],
    ["account", "Account Name", g.accountName],
    ["receipt", "Account Number", g.accountNumber],
    ["contrib", "Reference", g.reference],
  ]
    .map(
      ([image, label, value]) =>
        `<div class="bank-row"><span class="avatar">${icon(image)}</span><span class="grow">${label}</span><strong>${e(value || "—")}</strong>${label === "Account Number" && value ? `<button class="icon-btn" data-action="copy" data-copy="${e(value)}" aria-label="Copy account number">${icon("copy")}</button>` : ""}</div>`,
    )
    .join("")}</div>`;
}
function instructionsContent(showDetailsLink = true) {
  return `<section class="stack payment-block"><div class="stack" style="gap:10px"><h3>Payment Instructions</h3><p class="small muted">Payments are made outside the app. Transfer the amount to the details below, then upload your payment evidence.</p></div>${bankDetails()}<div class="note">${icon("info")}<div><strong>Note</strong><p style="margin-top:10px">Upload proof after payment</p></div></div>${showDetailsLink ? link("payment-instructions", "View Payment Instructions", "btn block") : ""}${link("upload-evidence", "Submit Payment Evidence", "btn secondary block")}</section>`;
}
function contributionDetails() {
  const c = currentContribution();
  if (!c)
    return empty(
      "No contribution selected",
      "View your contributions to select a payment.",
      link("contributions", "Contributions", "btn"),
    );
  return `${title("Contribution Details")}<div class="detail-columns details-mobile-order"><section class="card contribution-summary">${details(
    [
      ["Group", e(group()?.name)],
      ["Amount", money(c.amount)],
      ["Cycle", e(c.cycle || data.cycle?.name || "—")],
      [
        "Payment Date",
        e(
          preview && idOf(c) === "current"
            ? "31 Sep, 2026"
            : formatDate(c.paymentDate),
        ),
      ],
      ["Payment Status", pill(c.status)],
    ],
  )}</section>${recentContributions()}${instructionsContent()}</div>`;
}
function instructions() {
  return `${title("Payment Instructions")}<div class="narrow stack">${instructionsContent(false)}</div>`;
}
function submissionSuccess() {
  return `<div class="narrow stack" style="text-align:center;padding-top:48px">${icon("check")}${title("Evidence submitted", "Under review")}${link("dashboard", "Back Home", "btn block")}</div>`;
}
function legacyCorrection() {
  const c = currentContribution();
  return `${title("Correction required")}<div class="narrow stack"><div class="card stack">${details(
    [
      ["Group", e(group()?.name)],
      ["Amount", money(c?.amount)],
      ["Payment Status", pill("CORRECTION_REQUIRED")],
    ],
  )}<p class="muted">${e(c?.feedback || "Review the organizer’s feedback and update your submission.")}</p></div>${link("update-submission", "Update Submission", "btn block")}</div>`;
}
function paymentReviews() {
  return `${title("Pending Payment Reviews", "Review Member payment submissions and verify their evidence")}<div class="review-summary"><div class="row"><span class="avatar">${icon("payouts")}</span><div><span class="number">${data.reviews.length}</span><p>Pending Reviews</p></div></div><div class="row">${icon("groups")}<div><span class="number">${new Set(data.reviews.map((r) => r.groupName || r.groupId)).size}</span><p>Groups</p></div></div></div><div class="stack">${data.reviews.map((r) => link("payment-review", `${avatar(memberName(r.member))}<div class="grow"><h3>${e(memberName(r.member))}</h3><p>${e(r.groupName || group()?.name)}</p><p>Amount: ${money(r.amount)}</p></div>${pill("UNDER_REVIEW")}${icon("arrow")}`, "review-card", idOf(r))).join("") || empty("No pending payment reviews", "Payment submissions awaiting verification will appear here.")}</div>`;
}
function payouts() {
  const order = data.payoutOrder || [];
  return `${title("Payout Schedule")}<a href="#group-details" class="card row" style="color:inherit"><span class="avatar">${icon("groups")}</span><div style="flex:1"><h3>${e(group()?.name || "Savings Group")}</h3><p class="muted small">${e(data.cycle?.cycleNumber ? `Cycle ${data.cycle.cycleNumber}` : "Waiting for member approval")}</p></div>${icon("arrow")}</a><div class="row between"><h3>Recipient Order (${order.length} Members)</h3>${user?.role !== "MEMBER" ? link("payout-order", "Manage Order", "text-btn") : ""}</div><div class="payout-list">${order.map((member, i) => `<div class="payout-card"><span class="avatar">${member.position || i + 1}</span><div class="grow"><h3>${e(memberName(member))}</h3><p class="muted">${e(member.role || "member")}</p></div>${pill(member.status)}</div>`).join("") || empty("No payout recipients", "Approved group members will appear in the payout order.")}</div>${data.payouts.length ? `<h3>Payout History</h3><div class="payout-list">${data.payouts.map((p) => link("payout-details", `<div class="grow"><h3>${e(memberName(p.member))}</h3><p class="muted">Cycle ${e(p.cycleNumber)} ? ${e(formatDate(p.payoutDate))}</p></div><div class="meta">${pill(p.status)}<span>${money(p.amount)}</span></div>${icon("arrow")}`, `payout-card ${p.status === "pending_approval" ? "today" : ""}`, idOf(p))).join("")}</div>` : ""}${user?.role !== "MEMBER" ? button("Trigger Payout Phase", "trigger-payout", "", data.cycle?.cycleNumber && data.contributions.some((c) => c.status === "CONFIRMED") ? "" : "disabled") : ""}`;
}
function payoutDetails() {
  const p = data.payouts.find((p) => idOf(p) === routeId);
  if (!p)
    return empty(
      "Payout not found",
      "Choose a payout from the schedule.",
      link("payouts", "Back to Payout Schedule", "btn"),
    );
  return `${title("Payout Details")}<div class="narrow stack"><section class="card stack"><div class="row">${avatar(memberName(p.member))}<div><h3>${e(memberName(p.member))}</h3><p class="muted">Member, Position ${p.position}</p></div></div>${p.status === "pending_approval" ? `<div class="due-note row">${icon("calendar")}<div><h3>Due Today</h3><p>This payout is scheduled for today</p></div></div>` : pill(p.status)}${details(
    [
      ["Payout Date", e(formatDate(p.payoutDate))],
      ["Payout Amount", money(p.amount)],
      [
        "Cycle",
        preview
          ? 'Cycle 2<br><span class="muted small">Sep 1 - Sep 30, 2026</span>'
           : `Cycle ${e(p.cycleNumber)}`,
      ],
      ["Payout Position", `${p.position} of ${data.payouts.length}`],
    ],
  )}</section><div class="note">${icon("info")}<div><h3>Payout Happens externally</h3><p>Make the payout to the member through your preferred method. Then mark as completed in ThriftCircle</p></div></div>${user?.role !== "MEMBER" && p.status === "pending_approval" ? button("Mark Payout as Completed", "complete-payout", "block", `data-id="${e(idOf(p))}"`) : ""}${link("payouts", "Back to Payout Schedule", "btn secondary block")}</div>`;
}
function payoutOrder() {
  payoutDraft ||= [...(data.payoutOrder || [])];
  return `${title("Payout Order", "Arrange the receiving sequence for your group members.")}<div class="narrow stack">${payoutDraft.map((member, i) => `<div class="payout-card"><span class="avatar">${i + 1}</span><div class="grow"><h3>${e(memberName(member))}</h3><p class="muted">${e(member.phoneNumber || "")}</p></div><div class="row"><button class="icon-btn" aria-label="Move ${e(memberName(member))} up" data-action="move-payout" data-index="${i}" data-direction="-1" ${i === 0 ? "disabled" : ""}>${icon("chevrondown", "up")}</button><button class="icon-btn" aria-label="Move ${e(memberName(member))} down" data-action="move-payout" data-index="${i}" data-direction="1" ${i === payoutDraft.length - 1 ? "disabled" : ""}>${icon("chevrondown")}</button></div></div>`).join("")}${button("Save Payout Order", "save-payout-order", "block")}${link("payouts", "Cancel", "btn secondary block")}</div>`;
}
function issues() {
  return `${title("Pending Issues", "View and resolve reported issues.")}<div>${link("report-issue", "Report an Issue", "btn")}</div><div class="stack">${data.issues.map((issue) => link("issue-details", `<div style="flex:1"><h3>${e(issue.title || issue.category || "Payment Issue")}</h3><p>${e(issue.description)}</p></div>${pill(issue.status)}${icon("arrow")}`, "review-card", idOf(issue))).join("") || empty("No pending issues", "Reported group issues will appear here.")}</div>`;
}
function reportIssue() {
  const eligible = data.contributions.filter((c) => c.status === "PENDING_REVIEW");
  return `${title("Report a Payment Issue", "Report an issue with a contribution awaiting organizer review.")}<form id="report-issue-form" class="narrow stack">${select(
    "Contribution",
    "contributionId",
    [["", "Choose a contribution"], ...eligible.map((c) => [idOf(c), `${memberName(c.member)} ? ${money(c.amount)} ? ${formatDate(c.dueDate || c.paymentDate)}`])],
    "",
    "required",
  )}<label class="field"><strong>Description</strong><textarea name="description" placeholder="Describe the issue" required maxlength="2000"></textarea></label>${eligible.length ? "" : '<p class="note">There are no contributions awaiting review. The backend only accepts issues for contributions in review.</p>'}${formError}<button class="btn block" ${eligible.length ? "" : "disabled"}>Report Issue</button></form>`;
}
function issueDetails() {
  const issue = data.issues.find((i) => idOf(i) === routeId);
  if (!issue)
    return empty(
      "Issue not found",
      "Select an issue.",
      link("issues", "Pending Issues", "btn"),
    );
  return `${title("Issue Details")}<div class="card narrow stack"><h2>${e(issue.title || "Payment Issue")}</h2>${pill(issue.status)}<p>${e(issue.description)}</p>${user?.role !== "MEMBER" && issue.status !== "RESOLVED" ? button("Update Issue", "resolve-issue", "", `data-id="${e(idOf(issue))}"`) : ""}</div>`;
}
function notifications() {
  return `${title("Activity")}<div>${button("Mark all as read", "read-all", "secondary")}</div><div class="card activity-list">${data.notifications.map((n) => `<div class="list-row">${avatar("Activity")}<div class="grow"><p>${e(n.message || n.title)}</p><small>${e(formatDate(n.createdAt))}</small></div>${n.read || n.isRead ? "" : button("Mark read", "read-notification", "secondary compact", `data-id="${e(idOf(n))}"`)}</div>`).join("") || '<p class="muted">No notifications yet.</p>'}</div>`;
}
function profile() {
  return `${title("Profile")}<div class="card narrow stack"><div class="row">${avatar(memberName(user))}<div><h2>${e(memberName(user))}</h2><p class="muted">${e(user?.role)}</p></div></div>${details(
    [
      ["Email Address", e(user?.email || "—")],
      ["Phone Number", e(user?.phoneNumber || "—")],
    ],
  )}${preview ? `<div class="profile-switch">${button("View Organizer Pages", "switch-role", "secondary", 'data-role="ORGANIZER"')}${button("View Member Pages", "switch-role", "secondary", 'data-role="MEMBER"')}</div>` : ""}${button("Log Out", "logout", "secondary block")}</div>`;
}
function safeImage(url) {
  try {
    const parsed = new URL(url, location.href);
    return /^(https?:|blob:)$/.test(parsed.protocol) ? e(parsed.href) : "";
  } catch {
    return "";
  }
}
function contributionSummary(status = null) {
  const c = currentContribution();
  return `<section class="card contribution-summary">${details([
    ["Group", e(group()?.name)],
    ["Amount", money(c?.amount || group()?.contributionAmount)],
    ["Cycle", e(c?.cycle || data.cycle?.name || "September 2026")],
    [
      "Payment Date",
      e(
        preview && idOf(c) === "current"
          ? "31 Sep, 2026"
          : formatDate(c?.paymentDate),
      ),
    ],
    ["Payment Status", pill(status || c?.status || "DUE")],
  ])}</section>`;
}
function selectedReceipt(file = evidenceDraft.file) {
  const name =
    file?.name ||
    (activeScreen &&
    (/review|update/.test(route) || activeScreen.state === "success")
      ? "IMG_1234.jpg"
      : "");
  if (!name) return "";
  const size = file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : "2.4 MB";
  const image =
    file && receiptUrl && file.type !== "application/pdf"
      ? `<img src="${receiptUrl}" alt="Selected payment receipt" class="receipt-thumb">`
      : `<span class="avatar receipt-thumb">${icon("contrib")}</span>`;
  return `<div class="selected-receipt">${image}<div class="grow"><strong>${e(name)}</strong><p>${size} • Uploaded</p></div><button type="button" class="text-btn" data-action="remove-receipt" aria-label="Remove receipt">×</button></div>`;
}
function uploadEvidence() {
  const update = route === "update-submission";
  const c = currentContribution();
  return `${title(update ? "Update Submission" : "Upload Evidence")}${update ? `<div class="note">${icon("info")}<p>Only update the incorrect field or replace the evidence below. The other details are pre-filled to your original submission.</p></div>` : ""}<section class="stack evidence-summary" style="gap:16px"><h3>${update ? "Contribution Details" : "Contribution Summary"}</h3>${contributionSummary()}</section><form id="evidence-form" class="evidence-layout stack"><h3>Upload Payment Evidence</h3><p class="muted small">Upload a clear screenshot or receipt showing your payment. Supported format: JPEG, PNG, PDF (Max 5MB)</p><label class="upload-zone" id="receipt-drop-zone">${icon("contrib")}<span class="upload-desktop-label">Drag &amp; drop payment evidence here</span><span class="upload-mobile-label">Upload payment evidence</span><span class="tiny muted">Tap to choose • JPG, PNG or PDF</span><input id="receipt-file" name="file" type="file" accept="image/jpeg,image/png,application/pdf" aria-label="Choose payment evidence" ${evidenceDraft.file ? "" : "required"}></label><div id="receipt-container">${selectedReceipt()}</div>${formError}<button class="btn evidence-button" type="submit">${update ? "Continue to Review" : "Upload Evidence"}</button></form>`;
}
function reviewEvidence() {
  const resubmit = route === "review-resubmit";
  return `${title(resubmit ? "Review & Resubmit" : "Review Submission")}${resubmit ? `<div class="note">${icon("info")}<p>Your updated submission will be sent for review. You’ll be notified once it’s approved or if further action is required.</p></div>` : ""}${contributionSummary()}<form id="review-evidence-form" class="evidence-layout stack"><h3>Upload Payment Evidence</h3><p class="muted small">Upload a clear screenshot or receipt showing your payment. Supported format: JPEG, PNG, PDF (Max 5MB)</p><div class="uploaded-state">${icon("contrib")}<p>Payment evidence uploaded</p><small>File ready for organizer review</small></div>${selectedReceipt()}${formError}<button class="btn evidence-button" type="submit">${resubmit ? "Resubmit" : "Submit"}</button>${link(resubmit ? "update-submission" : "upload-evidence", "Back to Edit", "btn secondary evidence-button")}</form>`;
}
function correction() {
  const c = currentContribution();
  return `${title("Correction Required")}<div class="note amber-note">${icon("info")}<div><strong>${e(c?.feedbackTitle || "Incorrect Cycle")}</strong><p>${e(c?.feedback || "The cycle name does not match your current contribution. Please update your submission to continue.")}</p></div></div>${contributionSummary("CORRECTION_REQUIRED")}<section class="stack"><h3>What to fix</h3><div class="fix-step"><span class="avatar">1</span><p>Make sure the contribution is for the current circle.</p></div><div class="fix-step"><span class="avatar">2</span><p>Upload a clear receipts showing the correct details.</p></div></section>${link("update-submission", "Update Submission", "btn evidence-button")}`;
}
function contributionTabs() {
  return `<div class="contribution-tabs">${[
    ["", "All"],
    ["CONFIRMED", "Confirmed"],
    ["PENDING", "Pending"],
    ["OVERDUE", "Overdue"],
    ["ISSUE", "Issue"],
  ]
    .map(
      ([key, label]) =>
        `<button type="button" class="${contributionTab === key ? "active" : ""}" data-action="contribution-tab" data-value="${key}">${label}</button>`,
    )
    .join("")}</div>`;
}
function contributionTable(memberId = "") {
  const rows = data.contributions.filter(
    (c) =>
      (c.groupId === groupId || !c.groupId) &&
      (!memberId || !idOf(c.member) || idOf(c.member) === memberId) &&
      (!contributionTab ||
        String(c.status).includes(contributionTab) ||
        (contributionTab === "ISSUE" && /CORRECTION|ISSUE/.test(c.status))),
  );
  return `<section class="contribution-history-panel"><p>Contributions history</p>${contributionTabs()}<div class="table-wrap"><table class="contribution-table"><thead><tr><th>Amount</th><th>Contribution Date</th><th>Status</th><th>${memberId ? "Evidence" : "Action"}</th></tr></thead><tbody>${rows.map((c) => `<tr><td>${money(c.amount)}</td><td>${e(formatDate(c.paymentDate))}</td><td>${pill(c.status)}</td><td>${link(/ISSUE|CORRECTION/.test(c.status) ? "correction-required" : "contribution-status", `View ${icon("arrow")}`, "btn secondary compact", idOf(c))}</td></tr>`).join("") || '<tr><td colspan="4">No contributions match this filter.</td></tr>'}</tbody></table></div></section>`;
}
function contributions() {
  const d = data.dashboard || {};
  const stats = [
    ["Confirmed", d.confirmed ?? 0, "", "Payments received from members."],
    ["Pending", d.pending ?? 0, "amber", "Payments awaiting review"],
    ["Overdue", d.overdue ?? 0, "red", "Overdue contributions need attention."],
    ["Member", d.totalMembers ?? 0, "blue", "Total members in the group"],
  ];
  return `${title("Contribution", "Track contribution, verify payments, and manage your group’s progress.")}${cycleBar()}<div class="stat-grid">${stats.map(([label, n, color, description]) => `<div class="stat ${color}"><h3>${n} ${label}</h3><p>${description}</p></div>`).join("")}</div>${contributionTable()}${user?.role !== "MEMBER" ? `<div class="pending-actions">${link("payment-reviews", "Pending Payment Reviews", "btn secondary")}${link("issues", "Pending Issues", "btn secondary")}</div>` : ""}`;
}
function memberCard(m) {
  return `<section class="card member-profile"><div class="row between"><div class="row">${avatar(memberName(m))}<div><h3>${e(memberName(m))}</h3>${pill(m.status === "ACTIVE" ? "Active Member" : "Inactive Member")}</div></div></div><div class="member-meta"><span>${e(m.phoneNumber || "+234 8123456780")}</span><span>${e(m.email || (preview ? "ada.okafor@gmail.com" : "—"))}</span><span>Contribution Position ${m.position || 1} of ${group()?.memberCount || 10}</span><span>Member since ${e(preview ? "June,2026" : formatDate(m.joinedAt))}</span></div></section>`;
}
function memberDetails() {
  const m =
    (group()?.members || []).find((m) => idOf(m) === routeId) ||
    (activeScreen ? group()?.members?.[0] : null);
  if (!m)
    return empty(
      "Member not found",
      "Choose a member from the list.",
      link("members", "Member List", "btn"),
    );
  const cs = data.contributions.filter(
    (c) => !c.member || idOf(c.member) === idOf(m),
  );
  const confirmed = preview
    ? 7
    : cs.filter((c) => c.status === "CONFIRMED").length;
  const total = preview ? 10 : cs.length;
  const percentage = total ? Math.round((confirmed / total) * 100) : 0;
  return `${title("Member Details", "View and manage members details")}${cycleBar()}${memberCard(m)}<section class="card contribution-progress"><div><strong>Contribution Progress</strong><p class="small muted">${e(memberName(m).split(" ")[0])} has contributed ${confirmed} out of ${total} expected payments in this cycle.</p></div><div><strong>${percentage}%</strong><progress max="100" value="${percentage}" aria-label="Contribution progress">${percentage}%</progress></div></section>${contributionTable(idOf(m))}`;
}
function memberStatus() {
  return empty("Membership status changes are unavailable", "The backend supports approving or rejecting pending join requests, but it does not expose an endpoint for changing an active member?s status.", link("members", "Back to Members", "btn"));
}
function paymentReview() {
  const r =
    data.reviews.find((r) => idOf(r) === routeId) ||
    (activeScreen ? data.reviews[0] : null);
  if (!r)
    return empty(
      "Submission not found",
      "Select a payment submission.",
      link("payment-reviews", "Back to Reviews", "btn"),
    );
  return `${title("Payment Detail")}<div class="narrow stack"><section class="card payment-detail-card"><div class="row">${avatar(memberName(r.member))}<div><h3>${e(memberName(r.member))}</h3><p class="muted">Member, Position ${r.position || 2}</p></div></div>${details(
    [
      ["Payment Date", e(formatDate(r.paymentDate))],
      ["Payment Amount", money(r.amount)],
      ["Cycle", e(r.cycle || "Cycle 2")],
      ["Payment Reference", e(r.reference || "TRF-1042")],
    ],
  )}</section><section class="card stack"><h2>Payment Evidence</h2><div class="selected-receipt"><span class="avatar">${icon("contrib")}</span><div><strong>${e(r.evidence?.name || "IMG_1234.jpg")}</strong><p class="muted">${e(r.evidence?.size || "2.4 MB")} • Uploaded</p></div></div>${button("View Evidence", "view-evidence", "evidence-button", `data-id="${e(idOf(r))}"`)}</section>${user?.role !== "MEMBER" ? `<section class="card stack">${field("Feedback", "feedback", "text", "Add feedback (required for a correction)")}<div class="pending-actions">${button("Confirm Payment", "confirm-payment", "", `data-id="${e(idOf(r))}"`)}${button("Request Correction", "request-correction", "secondary", `data-id="${e(idOf(r))}"`)}</div></section>` : ""}</div>`;
}
function historyPage() {
  const rows = data.contributions.filter(
    (c) =>
      (c.groupId === groupId || !c.groupId) &&
      /CONFIRMED|APPROVED/.test(c.status),
  );
  if (!rows.length || activeScreen?.state === "empty")
    return `<div class="history-heading">Contribution History</div><section class="card history-empty">${icon("contrib")}<h3>No contributions yet</h3><p>No contribution has been made yet. Make a contribution to view your contribution history here.</p><div class="note">${icon("info")}<p>Once you make a contribution, it will appear here for your records.</p></div></section>`;
  return `<div class="history-heading">Contribution History</div>${recentPayments(true)}`;
}
function outstandingContribution() {
  return `${title("Outstanding Contribution")}<div class="narrow stack">${contributionSummary()}${link("payment-instructions", "View Payment Instructions", "btn")}${link("upload-evidence", "Record Payment", "btn secondary")}</div>`;
}
function contributionStatus() {
  const c =
    data.contributions.find((c) => idOf(c) === routeId) ||
    currentContribution();
  return `${title("Contribution Status")}<div class="narrow stack">${contributionSummary(c?.status)}<div class="note">${icon("info")}<p>${c?.status === "CONFIRMED" ? "Your payment has been confirmed." : c?.status === "UNDER_REVIEW" ? "Your payment evidence is awaiting organizer review." : "View your contribution details or record your payment."}</p></div>${link("contribution-details", "View Contribution Details", "btn block", idOf(c))}${/CORRECTION|ISSUE/.test(c?.status || "") ? link("correction-required", "View Feedback", "btn secondary block") : ""}</div>`;
}
function confirmIssue() {
  const eligible = data.contributions.filter((c) => c.status === "PENDING_REVIEW");
  return `${title("Report a Payment Issue")}<form id="confirm-issue-form" class="narrow stack">${select(
    "Contribution",
    "contributionId",
    [["", "Choose a contribution"], ...eligible.map((c) => [idOf(c), `${memberName(c.member)} ? ${money(c.amount)}`])],
    "",
    "required",
  )}<label class="field"><strong>Description</strong><textarea name="description" required placeholder="Describe the payment issue"></textarea></label>${formError}<button class="btn" ${eligible.length ? "" : "disabled"}>Report Issue</button></form>`;
}
function issueReported() {
  return `<div class="success-screen">${icon("check")}${title("Issue reported", "The organizer has been notified.")}${link("dashboard", "Back to Dashboard", "btn")}</div>`;
}
function splash() {
  return `<section class="splash-screen">${logo}${link("welcome", "Continue", "btn")}</section>`;
}
function passwordUpdated() {
  return authLayout(
    `<div class="card stack">${icon("check")}${title("Password Updated", "Your password has been updated successfully.")}${link("login", "Log In", "btn")}</div>`,
    7,
  );
}
function inactiveDashboard() {
  return `${title("Good morning, Opeyemi", "Here is what?s happening with your savings group.")}<section class="inactive-cycle">${icon("calendar")}<h2>No Active Cycle Yet</h2><p>Approve a member request first. The group cycle will start when its scheduled contribution date arrives.</p></section><section class="card stack"><h3>Quick Actions</h3>${link("members", "Manage Members", "list-row")}${link("groups", "View Groups", "list-row")}${link("group-settings", "Group Settings", "list-row")}</section>`;
}
function groupSettings() {
  const g = group();
  return `${title("Group Settings")}<section class="card narrow stack">${details(
    [
      ["Group Name", e(g?.name)],
      ["Contribution Amount", money(g?.contributionAmount)],
      ["Frequency", e(g?.frequency)],
      ["Require approval", "Yes"],
    ],
  )}${link("invite-members", "Invite Members", "btn")}${link("group-details", "View Group Details", "btn secondary", idOf(g))}</section>`;
}
function settings() {
  return `${title("Settings")}<section class="card narrow stack"><h3>Account</h3>${link("profile", "View Profile", "btn secondary")}${link("forgot-password", "Reset Password", "btn secondary")}${link("support", "Help & Support", "btn secondary")}${button("Log Out", "logout", "secondary")}</section>`;
}
function support() {
  return `${title("Help & Support")}<section class="card narrow stack"><h3>Payment and group issues</h3><p>Report an issue with a contribution, payout, or group membership.</p>${link("report-issue", "Report an Issue", "btn")}${user?.role !== "MEMBER" ? link("issues", "View Reported Issues", "btn secondary") : ""}</section>`;
}
function screensIndex() {
  const sections = [...new Set(screenCatalog.map((item) => item.section))];
  return `<section class="screen-index">${logo}${title("ThriftCircle screen preview", "Open any screen without signing in. Preview changes use sample data.")}<div class="pending-actions">${link("dashboard", "Organizer Dashboard", "btn")}${button("Member Dashboard", "switch-role", "secondary", 'data-role="MEMBER"')}${link("welcome", "Welcome", "btn secondary")}</div>${sections
    .map(
      (section) =>
        `<section class="screen-section"><h2>${e(section)}</h2><div class="screen-index-grid">${screenCatalog
          .filter((item) => item.section === section)
          .map(
            (item) =>
              `<a href="#screen/${encodeURIComponent(item.id)}" class="screen-index-card"><strong>${e(item.name)}</strong><span>${item.width < 700 ? "Mobile" : "Desktop"} · ${e(item.state)}</span><small>${item.reference === "saved" ? "Design reference saved" : item.reference === "wireframe" ? "Source contains wireframe placeholders" : "Exact design verification pending"}</small></a>`,
          )
          .join("")}</div></section>`,
    )
    .join("")}</section>`;
}
function evidenceState(state) {
  const loading = state === "loading";
  const failed = state === "error";
  const review = route === "review-submission" || route === "review-resubmit";
  const heading = activeScreen?.id === "856:3588" ? "Resubmit Evidence" : review ? "Review submission" : "Upload Evidence";
  const status = loading ? "Uploading" : failed ? "Failed" : "Uploaded";
  const receipt = selectedReceipt().replace("• Uploaded", `• ${status}`);
  const alert =
    review && failed
      ? `<div class="evidence-alert" role="alert">${icon("info")}<div><strong>Submission failed</strong><p>Kindly check your internet connection and retry.</p></div></div>`
      : "";
  const upload = review
    ? receipt
    : `<h3>Upload Payment Evidence</h3><p class="small muted">Upload a clear screenshot or receipt showing your payment. Supported format: JPEG, PNG, PDF (Max 5MB)</p><div class="upload-state ${failed ? "failed" : loading ? "loading" : "success-screen evidence-success"}" ${loading ? 'role="status" aria-label="Uploading payment evidence"' : failed ? 'role="alert"' : 'role="status"'}>${icon("contrib")}<strong>${loading ? "Uploading payment evidence" : failed ? "Upload failed" : "Payment evidence uploaded"}</strong><small>${loading ? "Please wait while your file uploads" : failed ? "Tap to retry • JPG, PNG or PDF" : "File ready for organizer review"}</small></div>${!loading && !failed ? receipt : ""}`;
  return `${title(heading)}${alert}${contributionSummary()}<section class="evidence-layout stack">${upload}${loading ? '<button type="button" class="btn evidence-button" disabled>Loading...</button>' : failed ? button("Retry", "retry-screen", "evidence-button") : link("review-submission", "Continue to Review", "btn evidence-button")}</section>`;
}
function stateView(content) {
  const state = activeScreen?.state;
  if (
    activeScreen?.width < 700 &&
    ["upload-evidence", "review-submission", "review-resubmit"].includes(
      route,
    ) &&
    ["loading", "error", "success"].includes(state)
  )
    return evidenceState(state);
  if (
    !state ||
    state === "default" ||
    state === "member" ||
    state === "organizer"
  )
    return content;
  if (state === "loading")
    return `${title(activeScreen.name.replace(/\(.*$/, "").trim())}<div class="state-loading" role="status" aria-label="Loading">${[1, 2, 3, 4].map(() => '<div class="skeleton"></div>').join("")}</div>`;
  if (state === "inactive" && route === "dashboard") return inactiveDashboard();
  if (state === "error" || state === "validation-error")
    return `${route === "submission-success" ? reviewEvidence() : route === "group-created" ? reviewGroup() : content}<div class="state-error" role="alert">${icon("info")}<div><strong>${state === "validation-error" ? "Please check the required fields." : /upload/i.test(route) ? "Upload failed. Please try again." : "Something went wrong. Please try again."}</strong>${button("Try again", "retry-screen", "secondary compact")}</div></div>`;
  if (state === "empty" && route !== "history")
    return `${title(route === "payment-reviews" ? "Pending Payment Reviews" : activeScreen.name)}${empty(route === "payment-reviews" ? "No pending payments" : "Nothing to show yet", "New activity will appear here when it is available.", link("dashboard", "Back Home", "btn secondary"))}`;
  if (state === "success")
    return `<div class="success-screen">${icon("check")}${title(/status/i.test(activeScreen.name) ? "Status updated successfully" : /upload/i.test(activeScreen.name) ? "Evidence uploaded successfully" : "Submission successful", /upload/i.test(activeScreen.name) ? "Your file is ready for review." : "Your update has been recorded.")}<div class="pending-actions">${link(/upload/i.test(activeScreen.name) ? "review-submission" : "dashboard", /upload/i.test(activeScreen.name) ? "Review Submission" : "Back Home", "btn")}</div></div>`;
  if (["confirmed", "pending", "overdue", "issue"].includes(state))
    return `<div class="state-heading">${pill(state === "issue" ? "PAYMENT_ISSUE" : state.toUpperCase())}</div>${content}`;
  return content;
}
function render() {
  const fn = routes[route];
  if (!fn) {
    app.innerHTML = shell(
      empty(
        "Page not found",
        "Choose a page from the menu.",
        link("dashboard", "Dashboard", "btn"),
      ),
    );
    return;
  }
  const markup = stateView(fn());
  if (authRoutes.has(route)) {
    document.body.className = "";
    app.innerHTML = markup;
  } else app.innerHTML = shell(markup);
  if (activeScreen) {
    document.body.classList.add(
      activeScreen.width < 700 ? "catalog-mobile" : "catalog-desktop",
    );
    if (route === "confirm-payment" && activeScreen.state === "default")
      modal(
        "Confirm Payment",
        "Confirm that you have verified this payment and its evidence.",
        "commit-confirm-payment",
        routeId,
        '<input type="hidden" name="feedback" value="">',
      );
  }
  document.body.classList.add(`route-${route}`);
  document.title = `${
    activeScreen?.name ||
    route
      .split("-")
      .map((x) => x[0]?.toUpperCase() + x.slice(1))
      .join(" ")
  } · ThriftCircle`;
}

const routes = {
  screens: screensIndex,
  splash,
  "password-updated": passwordUpdated,
  "member-status": memberStatus,
  "change-member-status": memberStatus,
  "review-resubmit": reviewEvidence,
  "outstanding-contribution": outstandingContribution,
  "contribution-status": contributionStatus,
  "confirm-issue": confirmIssue,
  "issue-reported": issueReported,
  "group-settings": groupSettings,
  settings,
  support,
  "view-evidence": paymentReview,
  "confirm-payment": paymentReview,
  welcome,
  role: chooseRole,
  login,
  signup,
  "forgot-password": forgot,
  "reset-password": reset,
  dashboard,
  groups,
  "group-details": groupDetails,
  "create-group": createGroup,
  "contribution-setup": contributionSetup,
  "group-rules": groupRules,
  "payout-configuration": payoutConfig,
  "review-group": reviewGroup,
  "group-created": groupCreated,
  "invite-members": invite,
  "join-group": joinGroup,
  members,
  "member-details": memberDetails,
  "pending-members": pendingMembers,
  contributions,
  "contribution-details": contributionDetails,
  "payment-instructions": instructions,
  "upload-evidence": uploadEvidence,
  "update-submission": uploadEvidence,
  "review-submission": reviewEvidence,
  "submission-success": submissionSuccess,
  "correction-required": correction,
  "payment-reviews": paymentReviews,
  "payment-review": paymentReview,
  payouts,
  "payout-details": payoutDetails,
  "payout-order": payoutOrder,
  issues,
  "report-issue": reportIssue,
  "issue-details": issueDetails,
  notifications,
  history: historyPage,
  profile,
};
const authRoutes = new Set([
  "screens",
  "splash",
  "password-updated",
  "welcome",
  "role",
  "login",
  "signup",
  "forgot-password",
  "reset-password",
]);
async function loadPage() {
  const stamp = ++requestVersion;
  if (dialog.open) dialog.close();
  const parts = location.hash.slice(1).split("/");
  route =
    parts[0] ||
    (preview &&
    (location.pathname.endsWith("/preview.html") ||
      location.pathname.endsWith("/demo.html"))
      ? "screens"
      : "welcome");
  try {
    routeId = decodeURIComponent(parts[1] || "");
  } catch {
    routeId = "";
  }
  activeScreen =
    preview && route === "screen"
      ? screenCatalog.find((item) => item.id === routeId)
      : null;
  if (activeScreen) {
    groupId = /Marvellous/.test(activeScreen.section) ? "atiba" : "family";
    route = activeScreen.route;
    routeId =
      route === "member-details" ||
      route === "member-status" ||
      route === "change-member-status"
        ? "member-1"
        : route === "payment-review" || route === "confirm-payment"
          ? "review-0"
          : route === "payout-details"
            ? "payout-1"
            : route === "issue-details" || route === "confirm-issue"
              ? "issue-sample"
              : "";
    const memberView =
      /Mayokun|Marvellous|Onboarding/.test(activeScreen.section) &&
      !/Organizer Dashboard/.test(activeScreen.name);
    user = {
      name: memberView ? "Mayokun Durosawo" : "Wemimo Opeyemi",
      role: memberView ? "MEMBER" : "ORGANIZER",
    };
    if (route === "role")
      role = activeScreen.state === "member" ? "MEMBER" : "ORGANIZER";
    if (route === "signup") role = "MEMBER";
  }
  filter = "";
  search = "";
  payoutDraft = null;
  contributionTab = ["confirmed", "pending", "overdue", "issue"].includes(
    activeScreen?.state,
  )
    ? activeScreen.state.toUpperCase()
    : "";
  if (!authRoutes.has(route) && !user) {
    go("login");
    return;
  }
  if (user?.role === "MEMBER" && ["issues", "issue-details", "confirm-issue"].includes(route)) {
    go("dashboard");
    return;
  }
  if (
    user?.role === "MEMBER" &&
    [
      "create-group",
      "contribution-setup",
      "group-rules",
      "payout-configuration",
      "review-group",
      "group-created",
      "invite-members",
      "pending-members",
      "payment-reviews",
      "payment-review",
      "payout-order",
      "member-status",
      "change-member-status",
    ].includes(route)
  ) {
    go("dashboard");
    return;
  }
  window.scrollTo(0, 0);
  if (!preview && route === "screens") {
    go("welcome");
    return;
  }
  if (preview || authRoutes.has(route)) {
    if (route === "group-details" && routeId) groupId = routeId;
    render();
    return;
  }
  app.innerHTML = shell(
    '<div class="loading-page" role="status" aria-label="Loading"><div class="skeleton"></div><div class="skeleton"></div></div>',
  );
  try {
    if (!ready) {
      data.groups = listOf(await api.myGroups(), "groups").map(normalizeGroup);
      ready = true;
    }
    if (stamp !== requestVersion) return;
    if (route === "group-details" && routeId) groupId = routeId;
    if (!data.groups.some((g) => idOf(g) === groupId))
      groupId = idOf(data.groups[0]);
    sessionStorage.setItem("thriftcircle.group", groupId);
    if (
      groupId &&
      !["groups", "join-group", "profile", "notifications"].includes(route)
    ) {
      const fullGroup = normalizeGroup(await api.group(groupId));
      data.groups = data.groups.map((g) =>
        idOf(g) === groupId ? { ...g, ...fullGroup } : g,
      );
      if (
        [
          "dashboard",
          "contributions",
          "history",
          "contribution-details",
          "payment-instructions",
          "upload-evidence",
          "update-submission",
          "review-submission",
          "correction-required",
          "payment-reviews",
          "payment-review",
          "payouts",
          "member-details",
          "contribution-status",
          "outstanding-contribution",
          "review-resubmit",
          "report-issue",
        ].includes(route)
      )
        data.contributions = listOf(await api.contributions(groupId), "contributions")
          .map(normalizeContribution)
          .map((c) => ({
            ...c,
            member: group()?.members?.find((m) => idOf(m) === idOf(c.member)) || c.member,
          }));
      if (
        [
          "dashboard",
          "members",
          "contributions",
          "group-details",
          "payouts",
          "payout-details",
        ].includes(route)
      )
        data.cycle = await api.currentCycle(groupId).then(unwrap).catch((error) => {
          // A group has no current cycle until one is created after member
          // approval. Treat that expected response as an empty state.
          if (
            error.status === 404 ||
            /no active cycle for this group/i.test(error.message || "")
          )
            return null;
          throw error;
        });
      if (route === "dashboard")
        data.dashboard = unwrap(
          await (user.role === "MEMBER"
            ? api.memberDashboard(groupId)
            : api.organizerDashboard(groupId)),
        ) || {};
      if (user.role === "MEMBER" && route === "dashboard") {
        const current = data.dashboard.currentContribution;
        if (current) {
          const normalized = normalizeContribution(current);
          data.contributions = [
            normalized,
            ...data.contributions.filter((c) => idOf(c) !== idOf(normalized)),
          ];
          data.cycle = { ...(data.cycle || {}), dueDate: normalized.dueDate, cycleNumber: normalized.cycleNumber };
        }
      }
      if (route === "dashboard" && user.role !== "MEMBER") {
        const d = data.dashboard;
        data.dashboard = {
          ...d,
          confirmed: data.contributions.filter((c) => c.status === "CONFIRMED").length,
          pending: data.contributions.filter((c) => c.status === "PENDING_REVIEW").length,
          overdue: data.contributions.filter((c) => c.status === "OVERDUE").length,
          totalMembers: d.memberCount,
        };
      }
      if (["group-details", "group-settings"].includes(route))
        data.rules = unwrap(await api.groupRules(groupId)) || {};
      if (route === "pending-members")
        data.pending = listOf(await api.pendingMembers(groupId), "members").map(normalizeMember);
      if (["payouts", "payout-details", "payout-order"].includes(route))
        data.payouts = listOf(await api.payouts(groupId), "payouts").map((p) => {
          const recipient = group()?.members?.find((m) => idOf(m) === idOf(p.recipientId));
          return { ...p, id: idOf(p), member: recipient || p.recipientId, position: recipient?.position, payoutDate: p.updatedAt || p.createdAt };
        });
      if (["payouts", "payout-order"].includes(route))
        data.payoutOrder = [...(group()?.members || [])].sort((a, b) => (a.position || 999) - (b.position || 999));
      if (["issues", "issue-details"].includes(route))
        data.issues = listOf(await api.issues(groupId), "issues");
      if (route === "contribution-details" && routeId) {
        const c = normalizeContribution(await api.contribution(routeId));
        data.contributions = [
          ...data.contributions.filter((x) => idOf(x) !== routeId),
          c,
        ];
      }
      if (["payment-reviews", "payment-review"].includes(route)) {
        const pending = data.contributions.filter((c) => c.status === "PENDING_REVIEW");
        data.reviews = await Promise.all(pending.map(async (c) => {
          const detail = normalizeContribution(await api.contribution(idOf(c)));
          const evidence = (detail.evidence || []).find((item) => item.reviewStatus === "PENDING") || detail.evidence?.[0];
          const member = group()?.members?.find((m) => idOf(m) === idOf(detail.member));
          return { ...detail, member, evidenceId: idOf(evidence), evidence: evidence ? { ...evidence, url: evidence.fileUrl, name: evidence.fileUrl?.split("/").pop() } : null };
        }));
      }
    }
    if (["dashboard", "notifications"].includes(route))
      data.notifications = listOf(await api.notifications(), "notifications");
    if (stamp === requestVersion) render();
  } catch (error) {
    if (stamp !== requestVersion) return;
    if (!user) {
      go("login");
      return;
    }
    app.innerHTML = shell(
      `<div class="error-panel" role="alert">${title("Unable to load this page")}<p style="margin:16px 0">${e(error.message)}</p>${button("Try again", "retry", "secondary")}</div>`,
    );
  }
}

function modal(heading, body, action = "", id = "", fields = "") {
  dialog.innerHTML = `<h2>${e(heading)}</h2><p>${e(body)}</p>${fields}<p class="form-error" role="alert"></p><div class="modal-actions">${button("Cancel", "close-modal", "secondary")}${action ? button("Confirm", action, "", `data-id="${e(id)}"`) : ""}</div>`;
  dialog.showModal();
}
async function runMutation(fn, after, target) {
  if (busy) return;
  busy = true;
  if (target) target.disabled = true;
  try {
    await fn();
    after?.();
  } catch (error) {
    const err = dialog.open
      ? dialog.querySelector(".form-error")
      : document.querySelector(".form-error");
    if (err) err.textContent = error.message;
    else notify(error.message);
  } finally {
    busy = false;
    if (target?.isConnected) target.disabled = false;
  }
}
function rememberUser(response) {
  const r = unwrap(response);
  const token = r?.accessToken || r?.tokens?.accessToken || r?.token;
  const u = r?.user;
  if (!token || !u)
    throw new Error("The server did not return an access token and user.");
  sessionStorage.setItem("thriftcircle.token", token);
  if (r?.refreshToken)
    sessionStorage.setItem("thriftcircle.refreshToken", r.refreshToken);
  user = u;
  sessionStorage.setItem("thriftcircle.user", JSON.stringify(u));
  ready = false;
}
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const error = form.querySelector(".form-error");
  if (error) error.textContent = "";
  const target = form.querySelector("button[type=submit],button:not([type])");
  try {
    if (form.id === "role-form") {
      role = values.role;
      go("signup");
      return;
    }
    if (
      values.confirmPassword !== undefined &&
      values.password !== values.confirmPassword
    )
      throw new Error("Passwords do not match.");
    if (form.id === "login-form") {
      await runMutation(
        async () => {
          if (preview)
            user = {
              name: role === "MEMBER" ? "Wemimo" : "Wemimo Opeyemi",
              role,
            };
          else
            rememberUser(
              await api.login({
                ...(values.loginIdentifier.includes("@")
                  ? { email: values.loginIdentifier.trim() }
                  : { phoneNumber: values.loginIdentifier.trim() }),
                password: values.password,
              }),
            );
        },
        () => go("dashboard"),
        target,
      );
      return;
    }
    if (form.id === "signup-form") {
      await runMutation(
        async () => {
          if (preview)
            user = {
              name: values.fullName,
              email: values.email,
              phoneNumber: values.phoneNumber,
              role,
            };
          else {
            const r = await api.signup({
              fullName: values.fullName,
              email: values.email,
              phoneNumber: values.phoneNumber,
              password: values.password,
              role,
            });
            const body = unwrap(r);
            if (body?.accessToken || body?.token || body?.tokens)
              rememberUser(r);
          }
        },
        () => {
          notify("Account created successfully.");
          go(user ? "dashboard" : "login");
        },
        target,
      );
      return;
    }
    if (form.id === "forgot-form") {
      await runMutation(
        () =>
          preview
            ? Promise.resolve()
            : api.forgotPassword({ email: values.email }),
        () => {
          resetEmail = values.email;
          sessionStorage.setItem("thriftcircle.resetEmail", resetEmail);
          go("reset-password");
        },
        target,
      );
      return;
    }
    if (form.id === "reset-form") {
      await runMutation(
        () =>
          preview
            ? Promise.resolve()
            : api.resetPassword({
                email: values.email,
                resetCode: values.resetCode,
                newPassword: values.password,
              }),
        () => {
          sessionStorage.removeItem("thriftcircle.resetEmail");
          resetEmail = "";
          notify("Password updated successfully.");
          go("login");
        },
        target,
      );
      return;
    }
    if (form.id === "create-group-form") {
      groupDraft = {
        ...groupDraft,
        ...values,
        memberCount: Number(values.memberCount),
      };
      go("contribution-setup");
      return;
    }
    if (form.id === "contribution-setup-form") {
      groupDraft = {
        ...groupDraft,
        ...values,
        contributionAmount: Number(values.contributionAmount),
      };
      go("group-rules");
      return;
    }
    if (form.id === "group-rules-form") {
      groupDraft = {
        ...groupDraft,
        ...values,
        gracePeriodDays: Number(values.gracePeriodDays),
        allowLateSubmission: values.allowLateSubmission === "true",
      };
      go("review-group");
      return;
    }
    if (form.id === "review-group-form") {
      if (!groupDraft.name || !groupDraft.contributionAmount || !groupDraft.frequency || !groupDraft.startDate || !groupDraft.contributionDeadline)
        throw new Error("Group name, contribution amount, frequency, start date, and contribution deadline are required.");
      await runMutation(
        async () => {
          const payload = {
            groupName: groupDraft.name,
            contributionAmount: groupDraft.contributionAmount,
            frequency: groupDraft.frequency.toLowerCase(),
            startDate: groupDraft.startDate,
            contributionDeadline: groupDraft.contributionDeadline,
            bankName: groupDraft.bankName.trim(),
            accountName: groupDraft.accountName.trim(),
            accountNumber: groupDraft.accountNumber.trim(),
            reference: groupDraft.reference?.trim() || "",
          };
          let g = preview
            ? {
                ...payload,
                name: payload.groupName,
                id: `group-${Date.now()}`,
                inviteCode: Math.random()
                  .toString(36)
                  .slice(2, 8)
                  .toUpperCase(),
                status: "ACTIVE",
                members: [],
              }
            : groupDraft.createdGroupId
              ? normalizeGroup(await api.group(groupDraft.createdGroupId))
              : normalizeGroup(await api.createGroup(payload));
          if (!idOf(g))
            throw new Error("The server did not return the created group ID.");
          if (!preview && !groupDraft.createdGroupId) {
            groupDraft.createdGroupId = idOf(g);
            groupId = idOf(g);
            data.groups = [...data.groups.filter((item) => idOf(item) !== groupId), g];
          }
          if (!preview && !groupDraft.rulesSaved) {
            await api.updateGroupRules(idOf(g), {
              gracePeriodDays: groupDraft.gracePeriodDays ?? 0,
              allowLateSubmission: groupDraft.allowLateSubmission ?? true,
              maxMembers: Number(groupDraft.memberCount) || null,
            });
            groupDraft.rulesSaved = true;
          }
          g = normalizeGroup(g);
          data.groups = [...data.groups.filter((item) => idOf(item) !== idOf(g)), g];
          groupId = idOf(g);
        },
        () => go("group-created"),
        target,
      );
      return;
    }
    if (form.id === "join-group-form") {
      await runMutation(
        async () => {
          if (!preview)
            await api.joinGroup({ inviteCode: values.inviteCode.trim() });
        },
        () =>
          modal(
            "Request submitted",
            "Your organizer will review your request to join the group.",
          ),
        target,
      );
      return;
    }
    if (form.id === "evidence-form") {
      const file =
        document.getElementById("receipt-file").files[0] || evidenceDraft.file;
      if (!file) throw new Error("Choose a receipt image.");
      if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type))
        throw new Error("Choose a JPG, PNG, or PDF file.");
      if (file.size > 5 * 1024 * 1024)
        throw new Error("The receipt must be 5 MB or smaller.");
      evidenceDraft = { ...evidenceDraft, ...values, file };
      if (receiptUrl && !data.reviews.some((r) => r.receiptUrl === receiptUrl))
        URL.revokeObjectURL(receiptUrl);
      receiptUrl = URL.createObjectURL(file);
      uploadedReturnRoute = route;
      go(
        route === "update-submission" ? "review-resubmit" : "review-submission",
      );
      return;
    }
    if (form.id === "review-evidence-form") {
      if (!evidenceDraft.file)
        throw new Error("Upload your payment evidence first.");
      await runMutation(
        async () => {
          const c = currentContribution();
          if (!c) throw new Error("No outstanding contribution was found for this group.");
          if (!preview) {
            const body = new FormData();
            body.append(config.evidenceField || "file", evidenceDraft.file);
            await api.uploadEvidence(idOf(c), body);
          } else if (c) {
            c.status = "UNDER_REVIEW";
            c.paymentDate = evidenceDraft.paymentDate;
            c.reference = evidenceDraft.reference;
            data.reviews.push({
              ...c,
              id: `review-${Date.now()}`,
              evidenceId: `evidence-${Date.now()}`,
              member: { name: memberName(user) },
              receiptUrl,
            });
          }
        },
        () => go("submission-success"),
        target,
      );
      return;
    }
    if (form.id === "report-issue-form") {
      await runMutation(
        async () => {
          const payload = {
            contributionId: values.contributionId,
            description: values.description.trim(),
          };
          if (preview)
            data.issues.push({
              ...payload,
              id: `issue-${Date.now()}`,
              status: "PENDING",
            });
          else await api.reportIssue(payload);
        },
        () => {
          notify("Issue reported.");
          go(user?.role === "MEMBER" ? "dashboard" : "issues");
        },
        target,
      );
      return;
    }
  } catch (err) {
    if (error) error.textContent = err.message;
    else notify(err.message);
  }
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === "password") {
    const input = target.closest(".password").querySelector("input");
    input.type = input.type === "password" ? "text" : "password";
    target.setAttribute(
      "aria-label",
      input.type === "password" ? "Show password" : "Hide password",
    );
    return;
  }
  if (action === "close-modal") {
    dialog.close();
    return;
  }
  if (action === "retry") {
    ready = false;
    loadPage();
    return;
  }
  if (action === "legal") {
    const url =
      target.dataset.kind === "privacy" ? config.privacyUrl : config.termsUrl;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else
      modal(
        target.dataset.kind === "privacy"
          ? "Privacy Policy"
          : "Terms of Service",
        "The project’s approved policy document has not been provided yet.",
      );
    return;
  }
  if (action === "copy" || action === "share") {
    const text = target.dataset.copy;
    if (!text) return;
    try {
      if (action === "share" && navigator.share)
        await navigator.share({ title: "Join my ThriftCircle group", text });
      else {
        await navigator.clipboard.writeText(text);
        notify("Copied to clipboard.");
      }
    } catch (err) {
      if (err.name !== "AbortError")
        notify(
          "Copy was unavailable. Select and copy the displayed code or link.",
        );
    }
    return;
  }
  if (action === "share-whatsapp" || action === "share-telegram") {
    const text = encodeURIComponent(target.dataset.copy);
    window.open(
      action === "share-whatsapp"
        ? `https://wa.me/?text=${text}`
        : `https://t.me/share/url?url=${text}`,
      "_blank",
      "noopener,noreferrer",
    );
    return;
  }
  if (action === "switch-role") {
    user = {
      name: target.dataset.role === "MEMBER" ? "Wemimo" : "Wemimo Opeyemi",
      role: target.dataset.role,
    };
    role = user.role;
    groupId = role === "MEMBER" ? "atiba" : "family";
    go("dashboard");
    return;
  }
  if (action === "logout") {
    await runMutation(
      () =>
        preview
          ? Promise.resolve()
          : api.logout({
              refreshToken: sessionStorage.getItem("thriftcircle.refreshToken"),
            }),
      () => {
        user = null;
        ready = false;
        sessionStorage.removeItem("thriftcircle.token");
        sessionStorage.removeItem("thriftcircle.refreshToken");
        sessionStorage.removeItem("thriftcircle.user");
        go("welcome");
      },
      target,
    );
    return;
  }
  if (action === "approve-member" || action === "reject-member") {
    modal(
      action === "approve-member" ? "Approve Member" : "Reject Member",
      "Confirm this membership decision.",
      "commit-" + action,
      id,
      field("Reason", "reason", "text", "Enter a reason"),
    );
    return;
  }
  if (action === "commit-approve-member" || action === "commit-reject-member") {
    const approved = action.includes("approve");
    const reason = dialog.querySelector("[name=reason]").value;
    await runMutation(
      async () => {
        if (preview) {
          const m = data.pending.find((m) => idOf(m) === id);
          data.pending = data.pending.filter((m) => idOf(m) !== id);
          if (approved && m)
            group().members.push({
              ...m,
              status: "ACTIVE",
              joinedAt: new Date().toISOString(),
            });
        } else
          await (approved
            ? api.approveMember(groupId, id, reason)
            : api.rejectMember(groupId, id, reason));
      },
      () => {
        dialog.close();
        notify(approved ? "Member approved." : "Request rejected.");
        loadPage();
      },
      target,
    );
    return;
  }
  if (action === "confirm-payment" || action === "request-correction") {
    const feedback = document.querySelector("[name=feedback]").value.trim();
    if (action === "request-correction" && !feedback) {
      notify("Add feedback before requesting a correction.");
      return;
    }
    modal(
      action === "confirm-payment" ? "Confirm Payment" : "Request Correction",
      action === "confirm-payment"
        ? "Confirm that you have verified this payment and its evidence."
        : feedback,
      "commit-" + action,
      id,
      `<input type="hidden" name="feedback" value="${e(feedback)}">`,
    );
    return;
  }
  if (
    action === "commit-confirm-payment" ||
    action === "commit-request-correction"
  ) {
    const review = data.reviews.find((r) => idOf(r) === id);
    const evidenceId = review?.evidenceId || idOf(review?.evidence);
    if (!preview && !evidenceId) {
      dialog.querySelector(".form-error").textContent =
        "This submission has no evidence ID to review.";
      return;
    }
    const approved = action.includes("confirm");
    const feedback = dialog.querySelector("[name=feedback]").value;
    await runMutation(
      async () => {
        if (preview) {
          review.status = approved ? "CONFIRMED" : "CORRECTION_REQUIRED";
          review.feedback = feedback;
          data.reviews = data.reviews.filter((r) => idOf(r) !== id);
        } else
          await api.reviewEvidence(evidenceId, {
            decision: approved ? "APPROVED" : "REJECTED",
            reviewNote: feedback,
          });
      },
      () => {
        dialog.close();
        notify(approved ? "Payment confirmed." : "Correction requested.");
        go("payment-reviews");
      },
      target,
    );
    return;
  }
  if (action === "trigger-payout") {
    modal(
      "Trigger Payout Phase",
      "Create a pending payout and move the current cycle into its payout phase?",
      "commit-trigger-payout",
    );
    return;
  }
  if (action === "commit-trigger-payout") {
    await runMutation(
      async () => {
        if (preview) data.cycle.status = "PAYOUT_PHASE";
        else {
          if (!data.cycle?.cycleNumber)
            throw new Error("There is no active cycle to pay out yet.");
          await api.triggerPayout(groupId, data.cycle.cycleNumber);
        }
      },
      () => {
        dialog.close();
        notify("Payout phase started.");
        loadPage();
      },
      target,
    );
    return;
  }
  if (action === "complete-payout") {
    modal(
      "Mark Payout as Completed",
      "Confirm that the payout has already been disbursed outside ThriftCircle.",
      "commit-complete-payout",
      id,
    );
    return;
  }
  if (action === "commit-complete-payout") {
    await runMutation(
      async () => {
        if (preview)
          data.payouts.find((p) => idOf(p) === id).status = "completed";
        else await api.approvePayout(id);
      },
      () => {
        dialog.close();
        notify("Payout marked as completed.");
        loadPage();
      },
      target,
    );
    return;
  }
  if (action === "move-payout") {
    const i = Number(target.dataset.index),
      j = i + Number(target.dataset.direction);
    if (
      !payoutDraft[j] ||
      payoutDraft[i].status === "completed" ||
      payoutDraft[j].status === "completed"
    )
      return;
    [payoutDraft[i], payoutDraft[j]] = [payoutDraft[j], payoutDraft[i]];
    render();
    return;
  }
  if (action === "save-payout-order") {
    await runMutation(
      async () => {
        const order = payoutDraft.map((member, i) => ({
          userId: idOf(member),
          payoutOrder: i + 1,
        }));
        validatePayoutOrder(data.payoutOrder, order);
        if (preview)
          data.payoutOrder = payoutDraft.map((member, i) => ({ ...member, position: i + 1 }));
        else await api.reorderPayouts(groupId, order);
      },
      () => {
        notify("Payout order updated.");
        go("payouts");
      },
      target,
    );
    return;
  }
  if (action === "resolve-issue") {
    modal(
      "Update Issue",
      "An issue remains open until corrected evidence is approved. Choose the next review status.",
      "commit-resolve-issue",
      id,
      `${select("Next Status", "status", [["UNDER_REVIEW", "Under review"], ["CORRECTION_REQUIRED", "Request correction"]], "UNDER_REVIEW", "required")}${field("Resolution Note", "resolutionNote", "text", "Explain the next step")}`,
    );
    return;
  }
  if (action === "commit-resolve-issue") {
    const status = dialog.querySelector("[name=status]").value;
    const resolutionNote = dialog.querySelector("[name=resolutionNote]").value.trim();
    if (status === "CORRECTION_REQUIRED" && !resolutionNote) {
      dialog.querySelector(".form-error").textContent = "Add a resolution note when requesting a correction.";
      return;
    }
    await runMutation(
      async () => {
        if (preview)
          data.issues.find((i) => idOf(i) === id).status = "RESOLVED";
        else await api.resolveIssue(id, { status, resolutionNote });
      },
      () => {
        dialog.close();
        notify("Issue updated.");
        go("issues");
      },
      target,
    );
    return;
  }
  if (action === "read-all" || action === "read-notification") {
    await runMutation(
      async () => {
        if (preview)
          data.notifications.forEach((n) => {
            if (action === "read-all" || idOf(n) === id) n.read = true;
          });
        else
          await (action === "read-all"
            ? api.readAllNotifications()
            : api.readNotification(id));
      },
      () => loadPage(),
      target,
    );
  }
});
document.addEventListener("change", (event) => {
  if (event.target.name === "role" && event.target.closest("#role-form"))
    event.target.closest("form").querySelector("button[type=submit]").disabled =
      false;
  if (event.target.id === "group-select") {
    groupId = event.target.value;
    sessionStorage.setItem("thriftcircle.group", groupId);
    loadPage();
  }
  if (event.target.id === "status-filter") {
    filter = event.target.value;
    render();
  }
  if (event.target.id === "receipt-file") {
    const file = event.target.files[0];
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "application/pdf"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      notify("Choose a JPG, PNG, or PDF file of 5 MB or smaller.");
      event.target.value = "";
      return;
    }
    if (receiptUrl && !data.reviews.some((r) => r.receiptUrl === receiptUrl))
      URL.revokeObjectURL(receiptUrl);
    receiptUrl = URL.createObjectURL(file);
    evidenceDraft.file = file;
    document.getElementById("receipt-container").innerHTML =
      selectedReceipt(file);
  }
});
document.addEventListener("input", (event) => {
  if (
    event.target.name === "description" &&
    document.getElementById("description-count")
  )
    document.getElementById("description-count").textContent =
      event.target.value.length;
  if (event.target.id === "list-search") {
    const pos = event.target.selectionStart;
    search = event.target.value;
    render();
    const replacement = document.getElementById("list-search");
    replacement?.focus();
    try {
      replacement?.setSelectionRange(pos, pos);
    } catch {}
  }
});
document.addEventListener("keydown", (event) => {
  if (event.target.id === "global-search" && event.key === "Enter") {
    go("contributions");
    search = event.target.value;
    render();
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (!["member-status-form", "confirm-issue-form"].includes(form.id)) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const target = form.querySelector("button[type=submit]");
  if (form.id === "confirm-issue-form") {
    await runMutation(
      async () => {
        const payload = {
          contributionId: values.contributionId,
          description: values.description.trim(),
        };
        if (preview)
          data.issues.push({
            ...payload,
            id: `issue-${Date.now()}`,
            status: "PENDING",
          });
        else await api.reportIssue(payload);
      },
      () => go("issue-reported"),
      target,
    );
  }
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === "contribution-tab") {
    contributionTab = target.dataset.value;
    render();
    return;
  }
  if (action === "retry-screen") {
    activeScreen = null;
    render();
    return;
  }
  if (action === "remove-receipt") {
    evidenceDraft.file = null;
    if (receiptUrl && !data.reviews.some((r) => r.receiptUrl === receiptUrl))
      URL.revokeObjectURL(receiptUrl);
    receiptUrl = "";
    go(uploadedReturnRoute);
    return;
  }
  if (action === "view-evidence") {
    const review = data.reviews.find((r) => idOf(r) === id);
    const source = review?.evidence?.url || review?.receiptUrl;
    const image = source ? safeImage(source) : "";
    dialog.innerHTML = `<button type="button" class="modal-close" data-action="close-modal" aria-label="Close evidence">×</button><h2>Payment Evidence</h2><div class="evidence-file-view">${image && !/\.pdf(?:\?|$)/i.test(image) ? `<img src="${image}" alt="Payment receipt">` : `<div class="empty">${icon("contrib")}<p>${image ? "PDF payment evidence" : "No receipt image is attached to this sample submission."}</p></div>`}${image ? `<a class="btn" href="${image}" target="_blank" rel="noopener noreferrer">Open Evidence</a>` : ""}${button("Close", "close-modal", "secondary")}</div>`;
    dialog.showModal();
  }
});
document.addEventListener("dragover", (event) => {
  if (event.target.closest?.("#receipt-drop-zone")) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (!event.target.closest?.("#receipt-drop-zone")) return;
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (
    !["image/jpeg", "image/png", "application/pdf"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  ) {
    notify("Choose a JPG, PNG, or PDF file of 5 MB or smaller.");
    return;
  }
  evidenceDraft.file = file;
  if (receiptUrl && !data.reviews.some((r) => r.receiptUrl === receiptUrl))
    URL.revokeObjectURL(receiptUrl);
  receiptUrl = URL.createObjectURL(file);
  const input = document.getElementById("receipt-file");
  if (input) input.required = false;
  document.getElementById("receipt-container").innerHTML =
    selectedReceipt(file);
});

window.addEventListener("hashchange", loadPage);
loadPage();

})();
