/**
 * Tenant-partitioned Socket.IO room keys (G2.11).
 *
 * Every authenticated socket joins exactly two rooms after login:
 *  - its user room  `t${tenantId}:u${userId}` — events only this user receives
 *  - its tenant room `t${tenantId}`           — tenant-wide broadcast events
 *
 * The compact `t`/`u` prefixed key format is the frozen contract from
 * docs/kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-11.md:
 * numeric ids keep room names short at scale and the prefixes prevent
 * collisions with legacy raw user-id room names.
 *
 * All emit call sites MUST route through these helpers instead of the legacy
 * `io.to(socket.userID)` scheme so no client can receive another tenant's
 * events.
 */

/**
 * Build the user-scoped room key for a tenant member.
 *
 * Source of truth for ids (G2.11, CTO pre-review KUM-82): always the NUMERIC
 * database ids. Sockets carry `socket.userID = user.id` (afterLogin) and
 * `socket.tenantID` from tenant_user rows, so call sites pass numbers; plain
 * numeric strings are tolerated and canonicalized so `"007"` and `7` can
 * never split into two different rooms.
 * @param {number} tenantId Tenant id
 * @param {number} userId User id
 * @returns {string} Room key in the form `t{tenantId}:u{userId}`
 */
const userRoom = (tenantId, userId) => {
    validateIds(tenantId, userId);
    return `t${Number(tenantId)}:u${Number(userId)}`;
};

/**
 * Build the tenant-wide broadcast room key.
 * @param {number} tenantId Tenant id
 * @returns {string} Room key in the form `t{tenantId}`
 * @throws {Error} If tenantId is not a positive integer id
 */
const tenantRoom = (tenantId) => {
    if (!isValidId(tenantId)) {
        throw new Error("tenantRoom requires a positive integer tenantId");
    }
    return `t${Number(tenantId)}`;
};

/**
 * Join a socket to both of its tenant-scoped rooms.
 * Call after login / tenant switch once `socket.tenantID` is resolved.
 * @param {Socket} socket Socket.io socket
 * @param {{tenantId: number, userId: number}} ctx Resolved tenant/user context
 * @returns {void}
 */
const joinUserRooms = (socket, { tenantId, userId }) => {
    socket.join(userRoom(tenantId, userId));
    socket.join(tenantRoom(tenantId));
};

/**
 * Leave every joined tenant room (user + tenant scoped).
 * Iterates `socket.rooms`, skipping the socket's own private room and any
 * non-tenant room (e.g. public status-page rooms owned by other features).
 * @param {Socket} socket Socket.io socket
 * @returns {void}
 */
const leaveUserRooms = (socket) => {
    for (const room of socket.rooms) {
        if (room !== socket.id && /^t\d+(?::|$)/.test(room)) {
            socket.leave(room);
        }
    }
};

/**
 * Assert both ids are usable room-key components.
 * @param {number} tenantId Tenant id
 * @param {number} userId User id
 * @returns {void}
 * @throws {Error} If either id is missing or non-numeric
 */
const validateIds = (tenantId, userId) => {
    if (!isValidId(tenantId) || !isValidId(userId)) {
        throw new Error("Tenant room helpers require positive integer tenantId and userId");
    }
};

/**
 * Check a value is a usable id for a room key. Only real ids are accepted:
 *  - `number` that is an integer >= 1, or
 *  - string of digits (`/^\d+$/`) whose numeric value is >= 1
 * (JWT/HTTP inputs may hand us numeric strings, so those stay valid).
 *
 * Everything else is rejected — booleans, arrays, objects and fractional /
 * signed / whitespace strings never coerce into an id (`true` must not become
 * `t1`, `[5]` must not become `t5`), and null/undefined/"" can never produce
 * a shared `t0` room (cross-tenant leak).
 * @param {any} id Value to check
 * @returns {boolean} True when the value is an unambiguous positive integer id
 */
const isValidId = (id) => {
    if (typeof id === "number") {
        return Number.isInteger(id) && id > 0;
    }
    if (typeof id === "string") {
        return /^\d+$/.test(id) && Number(id) > 0;
    }
    return false;
};

module.exports = {
    userRoom,
    tenantRoom,
    joinUserRooms,
    leaveUserRooms,
};
