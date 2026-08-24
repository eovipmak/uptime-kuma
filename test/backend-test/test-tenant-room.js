/**
 * G2.11 - Tenant Socket.IO room key helper tests
 *
 * Proves the frozen room-key contract from task-11:
 *  - user rooms are `t${tenantId}:u${userId}`, tenant rooms `t${tenantId}`
 *  - keys never collide with legacy raw user-id room names,
 *  - invalid ids (null/""/0/negative/non-numeric) throw instead of silently
 *    producing a shared `t0`/`tNaN` room (cross-tenant leak risk),
 *  - joinUserRooms joins exactly the two expected rooms and leaveUserRooms
 *    leaves every tenant room while preserving unrelated rooms (e.g. public
 *    status-page rooms) and the socket's own private room.
 *
 * Helper under test: server/socket-handlers/tenant-room.js (pure functions —
 * no database or server required).
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const { userRoom, tenantRoom, joinUserRooms, leaveUserRooms } = require("../../server/socket-handlers/tenant-room");

/**
 * Build a minimal socket double that records join/leave calls and keeps a
 * live Set of joined rooms like socket.io does.
 * @returns {object} Mock socket with id/rooms/join/leave + call recording
 */
function makeMockSocket() {
    const rooms = new Set();
    return {
        id: "socket-abc123",
        rooms,
        joins: [],
        leaves: [],
        join(room) {
            rooms.add(room);
            this.joins.push(room);
        },
        leave(room) {
            rooms.delete(room);
            this.leaves.push(room);
        },
    };
}

describe("room key format", () => {

    test("userRoom builds t{tenant}:u{user}", () => {
        assert.strictEqual(userRoom(7, 11), "t7:u11");
        assert.strictEqual(userRoom(1, 1), "t1:u1");
    });

    test("tenantRoom builds t{tenant}", () => {
        assert.strictEqual(tenantRoom(7), "t7");
        assert.strictEqual(tenantRoom(42), "t42");
    });

    test("keys cannot collide with legacy raw user-id rooms", () => {
        // Pre-G2 scheme joined `socket.join(user.id)` e.g. "11".
        assert.notStrictEqual(userRoom(7, 11), "11");
        assert.match(userRoom(7, 11), /^t\d+:u\d+$/);
        // userRoom(1, 23) must not equal tenantRoom(23) either.
        assert.notStrictEqual(userRoom(1, 23), tenantRoom(23));
    });
});

describe("id validation", () => {

    test("rejects ids that would coerce to a shared t0/tNaN room", () => {
        const bad = [ null, undefined, "", 0, -1, 1.5, "abc", NaN ];
        for (const v of bad) {
            assert.throws(() => userRoom(v, 1), undefined, `userRoom tenant ${String(v)}`);
            assert.throws(() => userRoom(1, v), undefined, `userRoom user ${String(v)}`);
            assert.throws(() => tenantRoom(v), undefined, `tenantRoom ${String(v)}`);
        }
    });

    test("accepts numeric strings (JWT claims may arrive as strings)", () => {
        assert.strictEqual(userRoom("7", "11"), "t7:u11");
        assert.strictEqual(tenantRoom("7"), "t7");
    });
});

describe("joinUserRooms", () => {

    test("joins exactly the user room and the tenant room", () => {
        const socket = makeMockSocket();
        joinUserRooms(socket, { tenantId: 3, userId: 9 });
        assert.deepStrictEqual(socket.joins.sort(), [ "t3", "t3:u9" ]);
        assert.ok(socket.rooms.has("t3"));
        assert.ok(socket.rooms.has("t3:u9"));
    });

    test("throws on missing context instead of joining a garbage room", () => {
        const socket = makeMockSocket();
        assert.throws(() => joinUserRooms(socket, { userId: 9 }));
        assert.throws(() => joinUserRooms(socket, { tenantId: 3 }));
        assert.strictEqual(socket.joins.length, 0);
    });
});

describe("leaveUserRooms", () => {

    test("leaves both tenant rooms but keeps own room and foreign rooms", () => {
        const socket = makeMockSocket();
        socket.join(socket.id);              // socket.io adds this automatically in reality
        socket.join("t3");
        socket.join("t3:u9");
        socket.join("public-room-xyz");      // e.g. status page room owned by another feature

        leaveUserRooms(socket);

        assert.ok(socket.rooms.has(socket.id));
        assert.ok(socket.rooms.has("public-room-xyz"));
        assert.ok(!socket.rooms.has("t3"));
        assert.ok(!socket.rooms.has("t3:u9"));
    });

    test("is safe to call when no tenant rooms were ever joined", () => {
        const socket = makeMockSocket();
        socket.join(socket.id);
        leaveUserRooms(socket);
        assert.deepStrictEqual(socket.leaves, []);
        assert.ok(socket.rooms.has(socket.id));
    });
});
