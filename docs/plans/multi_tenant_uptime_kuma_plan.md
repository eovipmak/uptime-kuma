# KẾ HOẠCH TỔNG QUÁT: MULTI-TENANT UPTIME KUMA

> **Tài liệu này dùng để phân phối cho các AI Agent nghiên cứu, mỗi Agent sẽ bung 1 giai đoạn thành các task chi tiết theo chuẩn nêu ở cuối tài liệu.**

---

## 📑 MỤC LỤC

1. [Tầm nhìn & Phạm vi](#-tầm-nhìn--phạm-vi-vision--scope)
2. [Nguyên tắc thiết kế](#-nguyên-tắc-thiết-kế-golden-image)
3. [Kế hoạch theo giai đoạn](#-kế-hoạch-theo-giai-đoạn)
   - [Giai đoạn 0 – Khảo sát & Thiết kế](#giai-đoạn-0--khảo-sát--thiết-kế-foundation)
   - [Giai đoạn 1 – Data Model & Migration](#giai-đoạn-1--data-model--migration)
   - [Giai đoạn 2 – Authentication & Tenant Context](#giai-đoạn-2--authentication--tenant-context)
   - [Giai đoạn 3 – RBAC](#giai-đoạn-3--rbac-role-based-access-control)
   - [Giai đoạn 4 – Repository / Query Layer](#giai-đoạn-4--repository--query-layer)
   - [Giai đoạn 5 – Monitoring Engine Multi-Tenant](#giai-đoạn-5--monitoring-engine-multi-tenant)
   - [Giai đoạn 6 – Status Page đa Tenant](#giai-đoạn-6--status-page-đa-tenant)
   - [Giai đoạn 7 – UI / UX (Frontend)](#giai-đoạn-7--ui--ux-frontend)
   - [Giai đoạn 8 – Billing & Quota](#giai-đoạn-8--billing--quota-tùy-chọn-nếu-saas)
   - [Giai đoạn 9 – Security, Observability & Hardening](#giai-đoạn-9--security-observability--hardening)
   - [Giai đoạn 10 – DevOps, CI/CD & Golden Image](#giai-đoạn-10--devops-cicd--golden-image)
   - [Giai đoạn 11 – Testing & QA](#giai-đoạn-11--testing--qa)
   - [Giai đoạn 12 – Documentation & Release](#giai-đoạn-12--documentation--release)
4. [Roadmap tóm tắt](#-roadmap-tóm-tắt)
5. [Hướng dẫn cho AI Agent](#-hướng-dẫn-cho-ai-agent-nghiên-cứu)

---

## 🎯 TẦM NHÌN & PHẠM VI (Vision & Scope)

**Sản phẩm cuối cùng:**
- Một instance Uptime Kuma phục vụ **N tenant** (khách hàng) độc lập.
- Mỗi tenant có: **monitors, notifications, status pages, users, tags, maintenance windows** riêng biệt.
- **Data isolation** nghiêm ngặt qua `tenant_id` – không thể xảy ra cross-tenant data leak.
- **RBAC 4 cấp:** Super Admin → Tenant Admin → Member → Viewer.
- Hỗ trợ **multi-workspace switcher** và **custom domain** cho status page.
- Backward compatible với data Uptime Kuma hiện có.

**Ngoài phạm vi (Out of scope) — trừ khi có yêu cầu bổ sung:**
- White-label toàn diện (logo, favicon, email template per tenant) — cân nhắc ở giai đoạn sau.
- Marketplace / plugin ecosystem.
- Multi-region active-active deployment.

---

## 🧭 NGUYÊN TẮC THIẾT KẾ (Golden Image)

| Nguyên tắc | Mô tả |
|---|---|
| **Standardization** | Mọi query DB đều bắt buộc filter theo `tenant_id`. Không có ngoại lệ. |
| **Zero Trust cross-tenant** | Middleware chặn từ HTTP layer, repository layer, và socket layer. |
| **Backward Compatible** | Data hiện tại migrate về `default_tenant`, không phá vỡ cài đặt cũ. |
| **Horizontal Scalable** | Không state trong process; scheduler/worker có thể chạy nhiều instance. |
| **Golden Image** | Docker image chuẩn hóa, versioned, immutable; cấu hình qua env vars. |
| **Observability by default** | Mọi log/metric/trace đều có label `tenant_id`. |

---

## 📋 KẾ HOẠCH THEO GIAI ĐOẠN

---

### GIAI ĐOẠN 0 – KHẢO SÁT & THIẾT KẾ (Foundation)

**Mục tiêu:** Hiểu codebase Uptime Kuma hiện tại, chốt kiến trúc target và các quyết định kỹ thuật lớn.

**Nhóm task nghiên cứu:**
- Phân tích cấu trúc source code Uptime Kuma (Node.js/Express + Vue + SQLite/MariaDB, Socket.IO).
- Rà soát toàn bộ **schema DB hiện tại**: `user`, `monitor`, `notification`, `status_page`, `tag`, `maintenance`, `heartbeat`, `incident`, `monitor_tag`, `monitor_notification`, `proxy`, `docker_host`, `api_key`, `monitor_group`, …
- Liệt kê tất cả **API endpoints & Socket.IO events** có tham chiếu tới `user` hoặc `monitor`.
- Đánh giá điểm chạm với **monitoring engine**: scheduler, heartbeat writer, notification dispatcher.
- Chọn **DB target**: khuyến nghị PostgreSQL/MySQL thay vì SQLite cho multi-tenant (concurrency, replication).
- Chốt **chiến lược isolation**:
  - Shared DB + Shared Schema + `tenant_id` column ✅ (khuyến nghị – đơn giản, hợp Uptime Kuma).
  - Shared DB + Schema-per-tenant (phức tạp hơn, migration khó).
  - DB-per-tenant (cô lập mạnh nhất, chi phí cao).

**Deliverable:**
- Architecture Decision Records (ADR) cho: DB choice, isolation model, routing strategy, auth strategy.
- Sơ đồ ERD "AS-IS" và "TO-BE".
- Rủi ro & mitigation plan.
- Danh sách file/module cần chỉnh sửa trong codebase.

**Definition of Done:**
- Team ký duyệt kiến trúc target.
- ADR được commit vào repo `docs/adr/`.

---

### GIAI ĐOẠN 1 – DATA MODEL & MIGRATION

**Mục tiêu:** Thêm khái niệm Tenant vào tầng dữ liệu, chuẩn bị nền tảng cho toàn bộ hệ thống.

**Nhóm task:**
- Tạo bảng mới:
  - `tenant` (id, name, slug, plan, created_at, updated_at, status, custom_domain, …).
  - `tenant_user` (tenant_id, user_id, role, joined_at) — quan hệ N-N.
  - `tenant_invitation` (email, token, role, expires_at) — mời user.
- Thêm cột `tenant_id` vào các bảng: `user` (nullable hoặc N-N qua `tenant_user`), `monitor`, `notification`, `status_page`, `tag`, `maintenance`, `heartbeat`, `incident`, `proxy`, `docker_host`, `api_key`, `monitor_group`.
- Viết **migration script** idempotent (Knex/Prisma migrations).
- Tạo **default tenant** cho data hiện tại → gán toàn bộ record cũ về tenant này.
- Thêm **composite indexes**: `(tenant_id, id)`, `(tenant_id, monitor_id)`, `(tenant_id, user_id)`, …
- **Foreign key + `ON DELETE CASCADE`** theo tenant để xóa sạch khi off-board.
- Seed data mẫu: 3 tenant demo (Acme, XYZ, 123) với data thực tế.
- Unit test cho migration up/down.

**Deliverable:**
- Migration files + rollback scripts.
- Seed script cho môi trường dev/staging.
- ERD cập nhật.

**Definition of Done:**
- Migration chạy sạch trên DB rỗng và DB có data cũ.
- Rollback không mất data.

---

### GIAI ĐOẠN 2 – AUTHENTICATION & TENANT CONTEXT

**Mục tiêu:** Mỗi request đều biết chính xác thuộc tenant nào.

**Nhóm task:**
- Refactor login flow: sau khi xác thực → trả về **danh sách tenant** user thuộc về.
- Cơ chế **Tenant Switcher**: người dùng chọn workspace sau login (giống Slack).
- JWT/Session payload chứa: `user_id`, `tenant_id`, `role`, `permissions`.
- Middleware `resolveTenant()` theo thứ tự ưu tiên:
  1. Subdomain (`acme.yourapp.com`)
  2. Custom domain (`status.acme.com`)
  3. Header `X-Tenant-ID`
  4. Session/JWT claim
- Middleware `requireTenantContext()` bảo vệ mọi route business (trả 400 nếu thiếu context).
- **Socket.IO namespace/room** theo `tenant_id` (client chỉ nhận event của tenant mình).
- Refresh token khi switch tenant.
- Xử lý edge case: user bị xóa khỏi tenant khi đang online → force logout.

**Deliverable:**
- Auth service refactored.
- Middleware chain chuẩn hóa (được reuse toàn hệ thống).
- Sequence diagram cho login + switch tenant.

**Definition of Done:**
- Không route nào business logic chạy được mà thiếu tenant context.
- Test tự động cho các flow: login, switch, logout, invalid tenant.

---

### GIAI ĐOẠN 3 – RBAC (Role-Based Access Control)

**Mục tiêu:** Phân quyền 4 cấp trong từng tenant.

**Nhóm task:**
- Định nghĩa **role matrix**:

| Role | Mô tả | Quyền chính |
|---|---|---|
| **Super Admin** | Quản trị toàn hệ thống | Quản lý tenant, billing, xem logs/metrics toàn hệ thống |
| **Tenant Admin** | Quản trị trong tenant | Quản lý monitor, notification, status page, user, xem báo cáo |
| **Member** | Thành viên | Xem monitor/status page, tạo/sửa monitor được cấp, quản lý notification của mình |
| **Viewer** | Chỉ xem | Chỉ đọc, không chỉnh sửa |

- Thiết kế `permissions`, `role_permissions` (hoặc hardcode enum nếu ít role).
- Decorator/middleware `@requireRole(['tenant_admin'])`, `@requirePermission('monitor.create')`.
- Policy layer: khuyến nghị **CASL** (isomorphic – dùng cả BE/FE) hoặc **accesscontrol.js**.
- UI: ẩn/hiện menu, disable button theo role (dùng CASL abilities).
- **Audit log** cho hành động nhạy cảm (thêm/xóa user, đổi role, xóa monitor).
- Một user có thể có role khác nhau ở các tenant khác nhau.

**Deliverable:**
- RBAC module tái sử dụng.
- Test case ma trận: từng role × từng endpoint.
- Tài liệu permission mapping.

**Definition of Done:**
- 100% endpoints business được bảo vệ RBAC.
- Không có "escalation path" (member không thể tự nâng quyền).

---

### GIAI ĐOẠN 4 – REPOSITORY / QUERY LAYER

**Mục tiêu:** Không còn query nào "quên" filter `tenant_id`.

**Nhóm task:**
- Xây **Base Repository** tự động inject `tenant_id` vào mọi query (find, update, delete).
- Refactor tất cả model: Monitor, Notification, StatusPage, Tag, Maintenance, Heartbeat, Incident.
- **Global query hook**: Prisma middleware / Sequelize hooks / Knex builder wrapper.
- **Custom lint rule** (ESLint plugin) cảnh báo khi có `.findMany()` / `.findFirst()` không kèm `tenant_id` trong `where`.
- **Integration test** đầy đủ: đăng nhập tenant A không thể đọc/sửa/xóa data tenant B qua bất kỳ endpoint nào.
- Xử lý các query đặc biệt: aggregate (COUNT, AVG uptime), report — vẫn phải filter tenant.
- Cache layer (Redis) có key prefix theo `tenant_id` để tránh cache poisoning cross-tenant.

**Deliverable:**
- Tenant-safe ORM layer.
- Test suite chống cross-tenant leak (chạy tự động trong CI).
- ESLint rule đóng gói thành package nội bộ.

**Definition of Done:**
- Test IDOR (Insecure Direct Object Reference) cross-tenant pass 100%.
- Code review checklist có mục "tenant filter".

---

### GIAI ĐOẠN 5 – MONITORING ENGINE MULTI-TENANT

**Mục tiêu:** Scheduler & heartbeat writer nhận biết tenant, không lẫn lộn.

**Nhóm task:**
- Scheduler load monitors theo tenant (partition by `tenant_id`).
- **Rate limit & quota** theo tenant: số monitor tối đa, tần suất check tối thiểu, số notification/giờ.
- Notification dispatcher gắn context tenant vào payload.
- Heartbeat writer ghi kèm `tenant_id`.
- Cân nhắc chiến lược worker:
  - **Shared pool + tenant tag** (đơn giản, phù hợp mọi tenant).
  - **Dedicated worker per large tenant** (cho enterprise plan).
- **Metrics Prometheus** với label `tenant_id`: heartbeat count, notification count, response time.
- Xử lý noisy neighbor: 1 tenant có 10.000 monitor không được chặn tenant khác.
- Retention policy heartbeat theo plan (Free: 7 ngày, Pro: 90 ngày, …).

**Deliverable:**
- Monitoring engine multi-tenant.
- Dashboard Grafana quota/usage per tenant.
- Load test report.

**Definition of Done:**
- Chạy ổn định với ≥ 100 tenant × 50 monitor trong staging.
- Không có tenant nào bị delay heartbeat > 10% do tenant khác.

---

### GIAI ĐOẠN 6 – STATUS PAGE ĐA TENANT

**Mục tiêu:** Mỗi tenant có status page riêng, truy cập qua nhiều kiểu URL.

**Nhóm task:**
- **3 chiến lược routing**:
  - **Subdomain:** `acme.status.yourapp.com`
  - **Path:** `yourapp.com/acme`
  - **Custom Domain:** `status.acme.com` (CNAME + SSL tự động qua Let's Encrypt/Caddy)
- Reverse proxy config: **Caddy** (auto SSL) hoặc **Traefik** (dynamic config), fallback Nginx + certbot.
- Trang public không cần auth nhưng phải **resolve đúng tenant** từ hostname/path.
- **Theme/branding riêng**: logo, màu chủ đạo, tên công ty, favicon.
- **SEO & meta tag** theo tenant (OG image, title, description).
- Wizard cấu hình custom domain có kiểm tra CNAME + tự động issue cert.
- Cache CDN-friendly cho status page public (short TTL, revalidate on incident).

**Deliverable:**
- Status page engine hỗ trợ 3 kiểu routing.
- Wizard cấu hình custom domain trong UI.
- Docs hướng dẫn khách hàng trỏ CNAME.

**Definition of Done:**
- Custom domain hoạt động end-to-end với SSL tự động.
- Không cross-tenant data trên trang public.

---

### GIAI ĐOẠN 7 – UI / UX (FRONTEND)

**Mục tiêu:** Trải nghiệm workspace mượt như Slack/Notion/Linear.

**Nhóm task:**
- **Tenant Switcher** dropdown ở header (avatar workspace, search, "+ Thêm workspace").
- **Onboarding flow**: tạo tenant đầu tiên, mời user qua email.
- Trang quản trị Tenant: user list, role assignment, invitation pending, billing (nếu có).
- **Trang Super Admin**: danh sách tenant, health status, usage metrics, action (suspend/delete).
- I18n giữ nguyên cấu trúc Uptime Kuma (vi/en/…).
- **Empty state, permission-denied state, error boundary**.
- Ability-based UI: dùng CASL để ẩn/disable component theo role.
- Responsive & dark mode giữ nguyên chuẩn Uptime Kuma.

**Deliverable:**
- Vue components tenant-aware.
- Design system cập nhật (Figma/Storybook).
- UX flow documented.

**Definition of Done:**
- Tất cả user story flow hoàn thành đúng thiết kế.
- Không có "flash of unauthorized content" khi load.

---

### GIAI ĐOẠN 8 – BILLING & QUOTA (Tùy chọn nếu SaaS)

**Mục tiêu:** Thương mại hóa – chỉ triển khai nếu đi hướng SaaS.

**Nhóm task:**
- **Gói dịch vụ**: Free / Pro / Business / Enterprise.
- Giới hạn per plan: số monitor, số user, số status page, số custom domain, retention heartbeat, tần suất check tối thiểu.
- Tích hợp **Stripe** hoặc **Paddle** (Merchant of Record – xử lý VAT tự động).
- Invoice, receipt, dunning (nhắc thanh toán).
- **Trial 14 ngày**, downgrade flow (giữ data readonly khi hết hạn).
- Webhook xử lý sự kiện: `subscription.updated`, `invoice.paid`, `invoice.failed`.
- Quota enforcement middleware.

**Deliverable:**
- Billing module.
- Pricing page.
- Docs cho khách hàng doanh nghiệp.

**Definition of Done:**
- Flow thanh toán end-to-end pass test.
- Downgrade/cancel không mất data quan trọng.

---

### GIAI ĐOẠN 9 – SECURITY, OBSERVABILITY & HARDENING

**Nhóm task:**
- **Pen-test** cross-tenant access (IDOR, JWT tampering, SSRF trong monitor URL).
- **Rate limit** theo tenant + IP (Redis-based).
- **Audit log tập trung**: ai làm gì trong tenant nào, immutable log (append-only).
- **Structured logging** (JSON) với `tenant_id`, `user_id`, `request_id`, `trace_id`.
- **Distributed tracing** (OpenTelemetry) với label tenant.
- **Backup & restore per tenant** (xuất/nhập JSON/SQL dump).
- **GDPR compliance**: export data, delete data theo tenant.
- **Secrets management**: Vault/AWS KMS/Doppler.
- Bảo vệ SSRF: monitor không được ping internal IP (10.x, 192.168.x, metadata endpoint).
- CSP, HSTS, security headers.

**Deliverable:**
- Security audit report.
- Runbook cho các sự cố bảo mật.
- Compliance checklist.

**Definition of Done:**
- Pass OWASP Top 10 review.
- Có quy trình response cho tenant yêu cầu xóa data.

---

### GIAI ĐOẠN 10 – DEVOPS, CI/CD & GOLDEN IMAGE

**Nhóm task:**
- **Docker image chuẩn hóa** (multi-stage build, non-root user, minimal base).
- **Docker Compose stack**: app + Postgres + Redis + Caddy (reverse proxy + SSL).
- **Helm chart** cho Kubernetes deploy (HPA, PDB, PVC).
- **CI pipeline**: lint → typecheck → test → build → security scan (Trivy/Snyk) → push image.
- **CD**: blue/green hoặc rolling update (K8s) / Watchtower (single node).
- Migration runner tự chạy khi startup (idempotent).
- **Healthcheck & readiness probe** phân biệt.
- **Golden Image versioning**: SemVer + git SHA trong tag.
- Infrastructure as Code (Terraform/Pulumi) — tùy chọn.

**Deliverable:**
- Golden Docker Image versioned.
- Helm chart / docker-compose.yml chuẩn.
- CI/CD pipeline chạy tự động.
- Deployment runbook.

**Definition of Done:**
- Deploy từ commit → production < 15 phút.
- Rollback trong < 5 phút.
- Không downtime khi rolling update.

---

### GIAI ĐOẠN 11 – TESTING & QA

**Nhóm task:**
- **Unit test** (Jest/Vitest) ≥ 70% coverage cho tenant logic.
- **Integration test** đa tenant chạy song song (test race condition).
- **E2E test** (Playwright/Cypress):
  - Đăng ký tenant → mời user → tạo monitor → xem heartbeat → publish status page.
  - Switch tenant, RBAC edge cases.
- **Load test** (k6/Locust): 1000 tenant × 100 monitor / tenant.
- **Security test**: OWASP Top 10 + IDOR cross-tenant + JWT fuzzing.
- **Chaos test**: kill worker, DB failover, network partition.
- Automated regression suite chạy nightly.

**Deliverable:**
- Test coverage report.
- Load test benchmark.
- QA sign-off checklist.

**Definition of Done:**
- Tất cả critical path có E2E test.
- CI fail nếu coverage giảm.

---

### GIAI ĐOẠN 12 – DOCUMENTATION & RELEASE

**Nhóm task:**
- **Tài liệu kiến trúc** (Markdown, mermaid diagram) trong `docs/`.
- **API docs** (OpenAPI/Swagger) có ví dụ tenant context và curl example.
- **Migration guide** từ Uptime Kuma gốc → multi-tenant version.
- **Runbook vận hành**: incident response, backup, restore, disaster recovery.
- **Changelog** và versioning (SemVer).
- **Release notes** cho từng version.
- Blog post & demo video giới thiệu.
- Docs cho khách hàng: setup custom domain, mời user, quản lý role.

**Deliverable:**
- `docs/` folder đầy đủ.
- Public documentation site (VitePress/Docusaurus).
- Video demo.

**Definition of Done:**
- Onboard 1 khách hàng mới không cần hỏi support.
- Team ops có runbook để xử lý ≥ 90% incident thường gặp.

---

## 🗺️ ROADMAP TÓM TẮT

| Ưu tiên | Giai đoạn | Ghi chú |
|---|---|---|
| **P0** | 0, 1, 2, 3, 4 | Nền tảng bắt buộc — không thể bỏ qua |
| **P1** | 5, 6, 7 | Trải nghiệm & giá trị cốt lõi cho khách hàng |
| **P2** | 9, 10, 11, 12 | Sẵn sàng production |
| **P3** | 8 | Chỉ khi thương mại hóa SaaS |

**Dependency graph (đơn giản hóa):**

```
G0 → G1 → G2 → G3 → G4 → G5 → G6 → G7 ─┐
                                        ├→ G9 → G10 → G11 → G12
                                   G8 ──┘ (optional)
```

---

## 📌 HƯỚNG DẪN CHO AI AGENT NGHIÊN CỨU

Khi nhận kế hoạch này, mỗi AI Agent nên tuân thủ quy trình sau:

### 1. Chọn phạm vi
- **Chọn 1 giai đoạn duy nhất** (G0 → G12) và bung ra thành các task chi tiết.
- Không nhảy giai đoạn – tuân thủ dependency graph.

### 2. Nghiên cứu source code
- **Đối chiếu với source code Uptime Kuma thật**: https://github.com/louislam/uptime-kuma
- Xác định chính xác **file/module cần chỉnh** (đường dẫn cụ thể).
- Ghi chú các điểm khó / breaking change.

### 3. Đề xuất ADR
- Với mỗi quyết định kiến trúc quan trọng (DB choice, isolation, routing, auth), viết 1 ADR ngắn.
- Format ADR: Context → Decision → Consequences → Alternatives.

### 4. Format output task chuẩn

Mỗi task xuất theo template Markdown sau:

```markdown
## Task <Giai đoạn>.<Số thứ tự> — <Tên task>

**Mô tả:**
<Mô tả chi tiết công việc cần làm>

**Acceptance Criteria (DoD):**
- [ ] Tiêu chí 1
- [ ] Tiêu chí 2
- [ ] ...

**Files/Modules ảnh hưởng:**
- `path/to/file1.js`
- `path/to/file2.vue`

**Estimate:** <S/M/L/XL hoặc số giờ>

**Dependencies:**
- Task X.Y (nếu có)

**Ghi chú kỹ thuật:**
<Gợi ý implementation, thư viện, pitfall>
```

### 5. Nguyên tắc bắt buộc
- Ưu tiên **standardization** và **Golden Image** trong mọi khuyến nghị hạ tầng.
- Luôn giữ **backward compatible** với data Uptime Kuma hiện có.
- Mọi feature phải có **test plan** đi kèm.
- Không đề xuất thay đổi kiến trúc lớn ngoài phạm vi giai đoạn được giao – ghi chú lại thành RFC riêng.

### 6. Output cuối cùng của mỗi Agent
- 1 file `.md` chứa danh sách task đầy đủ.
- 1 file `.md` chứa các ADR (nếu có).
- 1 sơ đồ (mermaid/PlantUML) mô tả kiến trúc/flow của giai đoạn.

---

**Version:** 1.0
**Ngày phát hành:** 2026-08-23
**Trạng thái:** Draft – sẵn sàng phân phối cho AI Agent
