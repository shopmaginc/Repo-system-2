/**
 * Shared domain types for the repo-system monorepo.
 * These are the contracts between the API and any future clients
 * (mobile app, desktop web). Keep them in sync with the Prisma schema.
 */

/** The five operating roles in the company. */
export const ROLE_NAMES = [
  'agent',
  'transport_driver',
  'lot_attendant',
  'office_clerk',
  'manager',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Account lifecycle for a user. */
export type UserStatus = 'active' | 'suspended' | 'revoked';

/** Field-level access granted by the manager-editable permission matrix. */
export type AccessLevel = 'hidden' | 'read' | 'write';

/** Entities that can carry field-level permissions. */
export const PERMISSION_ENTITIES = [
  'case',
  'debtor',
  'invoice',
  'user',
  'skip',
] as const;
export type PermissionEntity = (typeof PERMISSION_ENTITIES)[number];

/**
 * Known sensitive fields per entity. Anything not listed here — or not
 * granted in the matrix — is treated as `hidden` (default-deny).
 */
export const SENSITIVE_FIELDS: Record<PermissionEntity, string[]> = {
  case: ['clientInfo', 'lenderInfo', 'notes'],
  debtor: ['ssn', 'dob', 'homeAddress', 'personalPhone', 'email', 'skipResults'],
  invoice: ['amount', 'lineItems'],
  user: ['email', 'phone'],
  skip: ['results'],
};

/** A single row of the manager-editable permission matrix. */
export interface FieldGrant {
  entity: PermissionEntity | string;
  field: string;
  access: AccessLevel;
}

/** Minimal user shape attached to authenticated requests. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: RoleName | string;
  status: UserStatus;
  grants: FieldGrant[];
  canCaptureLotPhotos: boolean;
}

/** Standard API error shape. Never includes stack traces. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Auth token pair returned on login / refresh. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until the access token expires
}

/** Payload for POST /auth/login */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Payload for POST /admin/users (invite/create). */
export interface InviteUserRequest {
  name: string;
  email: string;
  phone?: string;
  role: RoleName;
  /** Optional initial password; a random one is generated when omitted. */
  password?: string;
}

// ---------------------------------------------------------------------------
// Phase 1 — case operations
// ---------------------------------------------------------------------------

/** The 11-stage case lifecycle from the blueprint, plus a terminal cancel. */
export const CASE_STATUSES = [
  'intake',
  'assigned',
  'field_work',
  'verify',
  'possession',
  'transport',
  'lot_storage',
  'condition_report',
  'delivery',
  'invoicing',
  'closed',
  'cancelled',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Documents the invoice gate requires before an invoice can be approved. */
export const DOCUMENT_KINDS = [
  'post_recovery_photos',
  'condition_report',
  'delivery_sheet',
  'delivery_confirmation',
  'invoice',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_STATUSES = ['pending', 'submitted', 'approved'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Payload for POST /cases/intake. Pass `{ id }` to link an existing record
 *  or `{ name, ... }` to create one inline. */
export interface IntakeRequest {
  caseNumber?: string;
  source?: 'rdn' | 'email' | 'manual';
  priority?: 'low' | 'normal' | 'high';
  notes?: string;
  debtor: { id?: string; name: string; ssn?: string; dob?: string; homeAddress?: string; personalPhone?: string; email?: string };
  client?: { id?: string; name: string; contactName?: string; contactPhone?: string; contactEmail?: string; contactCell?: string };
  lender?: { id?: string; name: string };
  asset?: { id?: string; vin: string; year?: number; make?: string; model?: string; color?: string; plate?: string; type?: string };
  addresses?: Array<{ label?: string; street: string; city?: string; state?: string; zip?: string }>;
}

/** Result of POST /cases/:id/verify-vin — the solo-agent double-check. */
export interface VinVerifyResult {
  match: boolean;
  scanA: string;
  scanB: string;
  assetVin: string;
  aMatchesAsset: boolean;
  bMatchesAsset: boolean;
  aMatchesB: boolean;
}

/** Result of GET /cases/:id/billing-eligibility — the invoice gate. */
export interface BillingEligibility {
  unlocked: boolean;
  documents: Array<{ kind: DocumentKind; status: DocumentStatus }>;
  /** Kinds still blocking the invoice (subset of the gate documents). */
  missing: DocumentKind[];
}

/** A VIN candidate pulled from pasted order text. */
export interface VinCandidate {
  vin: string;
  checkDigitValid: boolean;
}

// ---------------------------------------------------------------------------
// Phase 2 — field agent workspace
// ---------------------------------------------------------------------------

/** A geocoded stop on an assigned case. */
export interface FieldAddress {
  id: string;
  label: string;
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/** One row of GET /field/assignments. */
export interface FieldAssignment {
  id: string;
  caseNumber: string;
  status: CaseStatus;
  priority: string;
  asset: {
    vin: string;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    color?: string | null;
    plate?: string | null;
  } | null;
  debtor: Record<string, unknown> | null; // visibility-filtered
  clientName?: string | null;
  lenderName?: string | null;
  addresses: FieldAddress[];
  /** Meters from the requesting agent's position, when ?lat=&lng= given. */
  distanceMeters?: number | null;
}

/** Payload for POST /field/cases/:id/check-in. */
export interface CheckInRequest {
  lat: number;
  lng: number;
  note?: string;
}

/** Payload for POST /field/cases/:id/notes. */
export interface FieldNoteRequest {
  text: string;
}

/** Payload for POST /field/cases/:id/possession. */
export interface PossessionRequest {
  lat: number;
  lng: number;
}

// ---------------------------------------------------------------------------
// Phase 3 — recovery to invoice
// ---------------------------------------------------------------------------

/** Photo categories for lot intake and document scans. */
export const PHOTO_CATEGORIES = [
  'four_side',
  'vin_plate',
  'odometer',
  'damage',
  'document_scan',
  'other',
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

export interface PhotoRecord {
  id: string;
  category: PhotoCategory;
  caption?: string | null;
  mimeType: string;
  uploaderName?: string | null;
  createdAt: string;
}

/** Payload for POST /cases/:id/lot. */
export interface LotAssignRequest {
  lotId: string;
}

export interface LotRecord {
  id: string;
  name: string;
  address?: string | null;
  assignedAt?: string | null;
  assignedByName?: string | null;
}

/** One inspection checklist line. */
export interface InspectionItem {
  key: string;
  label: string;
  result: 'pass' | 'fail' | 'na';
  notes?: string;
}

/** Payload for POST /cases/:id/inspection. */
export interface InspectionRequest {
  assetType: 'tractor' | 'trailer';
  items: InspectionItem[];
}

/** Payload for POST /cases/:id/condition-report. */
export interface ConditionReportRequest {
  sections: Record<string, string>;
}

/** Payload for POST /cases/:id/deliver. */
export interface DeliverRequest {
  signedByName: string;
  lat?: number;
  lng?: number;
}

/** Payload for POST /cases/:id/invoice. */
export interface InvoiceRequest {
  invoiceNumber?: string;
  amount?: number;
}

/** One row of GET /review-queue. */
export interface ReviewQueueItem {
  documentId: string;
  kind: string;
  caseId: string;
  caseNumber: string;
  caseStatus: string;
  clientName?: string | null;
  submittedByName?: string | null;
  submittedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Phase 4 — research (skip) + client delivery (email)
// ---------------------------------------------------------------------------

/** Structured skip worksheet stored per case. */
export interface SkipWorksheet {
  knownAddresses: Array<{ street: string; city?: string; state?: string; zip?: string; source?: string }>;
  phones: Array<{ number: string; source?: string }>;
  associates: Array<{ name: string; relation?: string; notes?: string }>;
  vehicles: Array<{ vin?: string; plate?: string; description?: string }>;
  notes: string;
}

/** Deep-pull providers. Pulls are requested in the system; the vendor
 *  lookups themselves happen outside it (no vendor APIs). */
export const SKIP_PULL_PROVIDERS = ['infotracer', 'beenverified', 'opencorporates'] as const;
export type SkipPullProvider = (typeof SKIP_PULL_PROVIDERS)[number];

export const SKIP_PULL_STATUSES = ['requested', 'complete'] as const;
export type SkipPullStatus = (typeof SKIP_PULL_STATUSES)[number];

export interface SkipPullRecord {
  id: string;
  provider: SkipPullProvider;
  status: SkipPullStatus;
  summary?: string | null;
  resultRefs?: unknown;
  requestedByName?: string | null;
  requestedAt: string;
  completedAt?: string | null;
}

/** One cross-reference hit: another case linked to this debtor/asset. */
export interface CrossRefHit {
  caseId: string;
  caseNumber: string;
  status: string;
  /** e.g. ['debtor_phone', 'asset_vin', 'address_street'] */
  matchedOn: string[];
}

/** Seeded client-email templates. */
export const EMAIL_TEMPLATE_KEYS = [
  'recovery_photos',
  'delivery_confirmation',
  'condition_report',
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export interface EmailTemplateRecord {
  id: string;
  key: EmailTemplateKey;
  name: string;
  subject: string;
  body: string;
}

export const EMAIL_DRAFT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'rejected',
] as const;
export type EmailDraftStatus = (typeof EMAIL_DRAFT_STATUSES)[number];

/** Payload for POST /cases/:id/email/drafts. */
export interface EmailDraftRequest {
  templateKey: EmailTemplateKey;
  toContactId?: string;
  /** Manual recipient when no contact is chosen. */
  to?: string;
  cc?: string;
  subjectOverride?: string;
  bodyOverride?: string;
}

export interface EmailDraftRecord {
  id: string;
  templateKey: EmailTemplateKey;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  status: EmailDraftStatus;
  rejectionNote?: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  sentAt?: string | null;
  /** Always 'pending-smtp-config' in this build — see send endpoint docs. */
  transport?: string | null;
  createdAt: string;
}

/** Payload for POST /clients/:id/contacts and PATCH /clients/:id/contacts/:contactId. */
export interface ClientContactRequest {
  name: string;
  role?: string;
  phone?: string;
  email?: string;
  cell?: string;
  notes?: string;
}

/** One row of the shared company contact directory. */
export interface ClientContactRecord {
  id: string;
  clientId: string;
  clientName?: string | null;
  name: string;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  cell?: string | null;
  notes?: string | null;
}

/* ------------------------------------------------------------------ */
/* Phase 5 — company operations: messaging, directory, time off.       */
/* ------------------------------------------------------------------ */

/** Conversation kinds. 'company_wide' auto-includes all active users. */
export const CONVERSATION_KINDS = ['direct', 'company_wide'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** Payload for POST /conversations. */
export interface ConversationRequest {
  kind: ConversationKind;
  title?: string;
  /** Required for 'direct': the other participants' user ids. */
  memberIds?: string[];
}

/** One conversation in GET /conversations. */
export interface ConversationRecord {
  id: string;
  kind: ConversationKind;
  title?: string | null;
  memberCount: number;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

/** Payload for POST /conversations/:id/messages. */
export interface MessageRequest {
  body: string;
  /** Photo/video refs from POST /uploads: [{ ref, name, mimeType }]. */
  attachmentRefs?: Array<{ ref: string; name?: string; mimeType?: string }>;
}

/** One message in GET /conversations/:id/messages. */
export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole?: string | null;
  body: string;
  attachmentRefs?: Array<{ ref: string; name?: string; mimeType?: string }> | null;
  createdAt: string;
}

/** Payload for POST /directory and PATCH /directory/:id. */
export interface DirectoryContactRequest {
  name: string;
  company?: string;
  role?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

/** One row of the shared company directory. */
export interface DirectoryContactRecord {
  id: string;
  name: string;
  company?: string | null;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  addedByName?: string | null;
}

/** Payload for POST /time-off. */
export interface TimeOffRequestBody {
  startDate: string; // ISO date
  endDate: string; // ISO date
  reason?: string;
}

export type TimeOffStatus = 'pending' | 'approved' | 'denied';

/** One time-off request. */
export interface TimeOffRecord {
  id: string;
  userId: string;
  userName?: string | null;
  startDate: string;
  endDate: string;
  reason?: string | null;
  status: TimeOffStatus;
  decidedByName?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
}

/** One row of GET /dispatch/availability. */
export interface AvailabilityRecord {
  userId: string;
  name: string;
  role: string;
  phone?: string | null;
}

/** GET /reports/week — this week's numbers for the manager dashboard. */
export interface WeeklyReport {
  weekStart: string; // ISO date (Monday)
  casesByStatus: Record<string, number>;
  possessions: number; // cases that reached 'possession' this week
  deliveries: number; // cases that reached 'delivery' this week
  invoicesCreated: number;
  invoicesApproved: number;
  avgDaysIntakeToPossession: number | null;
  perAgent: Array<{
    agentId: string;
    agentName: string;
    assignedCases: number;
    possessions: number;
  }>;
}

/** Payload for POST /alpr/lists and PUT /alpr/lists/:id. */
export interface PlateListRequest {
  name?: string;
  /** Free-text client label. */
  client?: string | null;
  /** Full plate set — replaces any existing entries. */
  plates: Array<{ plate: string; state?: string; notes?: string }>;
}

/** One watch list in GET /alpr/lists. */
export interface PlateListRecord {
  id: string;
  name: string;
  client?: string | null;
  plateCount: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** One entry in GET /alpr/lists/:id. */
export interface PlateEntryRecord {
  id: string;
  plate: string;
  state?: string | null;
  notes?: string | null;
  addedAt: string;
}

/** Payload for POST /alpr/hits. */
export interface PlateHitRequest {
  plate: string;
  state?: string;
  /** OCR confidence 0-1. */
  confidence?: number;
  latitude?: number;
  longitude?: number;
  /** ISO datetime the scan happened. */
  scannedAt: string;
  /** Storage ref if a hit photo was uploaded. */
  photoRef?: string;
  /** Which phone reported it. */
  deviceId?: string;
}

/** One hit report in POST /alpr/hits and GET /alpr/hits. */
export interface PlateHitRecord {
  id: string;
  plate: string;
  state?: string | null;
  confidence?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  scannedAt: string;
  photoRef?: string | null;
  deviceId?: string | null;
  reportedById: string;
  reporterName?: string | null;
  createdAt: string;
}
