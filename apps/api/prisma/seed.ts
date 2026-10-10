/**
 * Phase 0 seed script.
 *
 * Creates:
 *  - the 5 operating roles (lot-capture duties granted to every role)
 *  - the default field-permission matrix (PII hidden for all but manager)
 *  - device policies (personal vs company-owned)
 *  - one DEV-ONLY manager account
 *
 * Run: npm run db:seed   (requires DATABASE_URL + migrated database)
 *
 * The dev credentials printed below are for local development ONLY.
 * Never use them in production, never commit real secrets.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();

type Access = 'hidden' | 'read' | 'write';
interface Grant {
  entity: string;
  field: string;
  access: Access;
}

const ROLES: { name: string; description: string }[] = [
  { name: 'agent', description: 'Field repossession agent — finds, verifies, recovers units' },
  { name: 'transport_driver', description: 'Moves recovered units between locations and deliveries' },
  { name: 'lot_attendant', description: 'Lot intake, inventory, and in-depth inspections' },
  { name: 'office_clerk', description: 'Order intake, documents, client forms, printing' },
  { name: 'manager', description: 'Full visibility, assignments, approvals, billing, user admin' },
];

/**
 * Default permission matrix. Principle: PII (ssn, dob, personal phones and
 * addresses, skip results) is HIDDEN for every role except manager.
 * Field staff get exactly what the job needs: VINs, plates, addresses on
 * their assigned cases, client-rep contact info — nothing more.
 */
const MATRIX: Record<string, Grant[]> = {
  manager: [
    // Managers see everything. Enumerate the sensitive fields explicitly so
    // future fields stay hidden-by-default for everyone else.
    { entity: 'debtor', field: 'name', access: 'write' },
    { entity: 'debtor', field: 'ssn', access: 'read' },
    { entity: 'debtor', field: 'dob', access: 'read' },
    { entity: 'debtor', field: 'homeAddress', access: 'read' },
    { entity: 'debtor', field: 'personalPhone', access: 'read' },
    { entity: 'debtor', field: 'email', access: 'read' },
    { entity: 'debtor', field: 'skipResults', access: 'read' },
    { entity: 'case', field: 'vin', access: 'write' },
    { entity: 'case', field: 'plate', access: 'write' },
    { entity: 'case', field: 'status', access: 'write' },
    { entity: 'case', field: 'addresses', access: 'write' },
    { entity: 'case', field: 'notes', access: 'write' },
    { entity: 'case', field: 'clientInfo', access: 'write' },
    { entity: 'case', field: 'lenderInfo', access: 'write' },
    { entity: 'invoice', field: 'amount', access: 'write' },
    { entity: 'invoice', field: 'lineItems', access: 'write' },
    { entity: 'invoice', field: 'status', access: 'write' },
    { entity: 'user', field: 'name', access: 'write' },
    { entity: 'user', field: 'email', access: 'write' },
    { entity: 'user', field: 'phone', access: 'write' },
    { entity: 'user', field: 'role', access: 'write' },
    { entity: 'skip', field: 'results', access: 'read' },
  ],
  agent: [
    { entity: 'debtor', field: 'name', access: 'read' },
    // ssn / dob / homeAddress / personalPhone / skipResults: hidden (default)
    { entity: 'case', field: 'vin', access: 'read' },
    { entity: 'case', field: 'plate', access: 'read' },
    { entity: 'case', field: 'status', access: 'read' },
    { entity: 'case', field: 'addresses', access: 'read' },
    { entity: 'case', field: 'notes', access: 'write' },
    { entity: 'case', field: 'clientInfo', access: 'read' },
    { entity: 'case', field: 'lenderInfo', access: 'read' },
  ],
  transport_driver: [
    { entity: 'debtor', field: 'name', access: 'read' },
    { entity: 'case', field: 'vin', access: 'read' },
    { entity: 'case', field: 'plate', access: 'read' },
    { entity: 'case', field: 'status', access: 'read' },
    { entity: 'case', field: 'addresses', access: 'read' },
    { entity: 'case', field: 'notes', access: 'write' },
    { entity: 'case', field: 'clientInfo', access: 'read' },
  ],
  lot_attendant: [
    { entity: 'debtor', field: 'name', access: 'read' },
    { entity: 'case', field: 'vin', access: 'read' },
    { entity: 'case', field: 'plate', access: 'read' },
    { entity: 'case', field: 'status', access: 'read' },
    { entity: 'case', field: 'notes', access: 'write' },
  ],
  office_clerk: [
    { entity: 'debtor', field: 'name', access: 'write' },
    { entity: 'debtor', field: 'email', access: 'write' },
    // ssn / dob / homeAddress / personalPhone / skipResults: hidden (default)
    { entity: 'case', field: 'vin', access: 'write' },
    { entity: 'case', field: 'plate', access: 'write' },
    { entity: 'case', field: 'status', access: 'write' },
    { entity: 'case', field: 'addresses', access: 'write' },
    { entity: 'case', field: 'notes', access: 'write' },
    { entity: 'case', field: 'clientInfo', access: 'write' },
    { entity: 'case', field: 'lenderInfo', access: 'write' },
    { entity: 'invoice', field: 'status', access: 'read' },
  ],
};

/** DEV-ONLY manager credentials — local development, never production. */
const DEV_EMAIL = 'manager@repo-system.local';
const DEV_PASSWORD = 'ChangeMe123!dev-only';

/** True when the seed runs against production — demo data and dev
 * credentials are never created there. Safe operational seeds (roles,
 * permission matrix, device policies, lots, email templates) still run. */
function isProductionSeed(): boolean {
  return process.env.NODE_ENV === 'production';
}

async function main(): Promise<void> {
  const production = isProductionSeed();
  if (production) {
    console.log('Production seed: creating operational data only.');
    console.log('Skipped (production): DEV-ONLY manager account, demo case/client/debtor/agent,');
    console.log('  demo directory contacts, demo client contact, company-wide channel seed.');
    console.log('  Create the first real manager via POST /admin/users once the API is up.');
    console.log('');
  }
  // --- Roles (lot-capture duties granted to every role) ---
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { name: r.name },
      create: { name: r.name, description: r.description, canCaptureLotPhotos: true },
      update: { description: r.description, canCaptureLotPhotos: true },
    });
  }

  // --- Lots (Phase 3) ---
  for (const lot of [
    { name: 'Main Lot — Laredo', address: '110 Coal Mines Rd, Laredo, TX 78045', notes: 'Primary secure storage' },
    { name: 'North Yard', address: 'Laredo, TX', notes: 'Overflow trailers' },
  ]) {
    await prisma.lot.upsert({
      where: { name: lot.name },
      create: lot,
      update: { address: lot.address, notes: lot.notes },
    });
  }

  // --- Default permission matrix ---
  for (const [roleName, grants] of Object.entries(MATRIX)) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    for (const g of grants) {
      await prisma.fieldPermission.upsert({
        where: { roleId_entity_field: { roleId: role.id, entity: g.entity, field: g.field } },
        create: { roleId: role.id, entity: g.entity, field: g.field, access: g.access },
        update: { access: g.access },
      });
    }
  }

  // --- Device policies ---
  await prisma.devicePolicy.upsert({
    where: { name: 'personal' },
    create: {
      name: 'personal',
      blockScreenshotsOnPersonalDevices: true,
      allowLocalDownloads: false,
      notes: 'Default for personal phones. Screenshots/screen recording blocked where the native app supports it.',
    },
    update: {},
  });
  await prisma.devicePolicy.upsert({
    where: { name: 'company_owned' },
    create: {
      name: 'company_owned',
      blockScreenshotsOnPersonalDevices: false,
      allowLocalDownloads: true,
      notes: 'Company-owned devices. Policy adjustable per device enrollment.',
    },
    update: {},
  });

  if (!production) {
    // --- DEV-ONLY manager account (never in production) ---
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'manager' } });
    await prisma.user.upsert({
      where: { email: DEV_EMAIL },
      create: {
        name: 'Dev Manager',
        email: DEV_EMAIL,
        roleId: managerRole.id,
        passwordHash: await hashPassword(DEV_PASSWORD),
        status: 'active',
      },
      update: {},
    });
  }

  console.log('');
  console.log('Seed complete.');
  console.log('  Roles: agent, transport_driver, lot_attendant, office_clerk, manager');
  console.log('  Device policies: personal, company_owned');
  console.log('');
  if (!production) {
    console.log('  ===== DEV-ONLY CREDENTIALS (local development only — never use in production) =====');
    console.log(`  email:    ${DEV_EMAIL}`);
    console.log(`  password: ${DEV_PASSWORD}`);
    console.log('  ==================================================================================');
    console.log('');
  }

  if (!production) {
    await seedPhase1Demo();
  } else {
    console.log('Skipped (production): Phase 1 demo case data.');
  }
  await seedPhase4(production);
  await seedPhase5(production);

  // --- Production first-admin bootstrap ---
  // In production there is no dev manager account. Setting SEED_ADMIN_EMAIL
  // (+ SEED_ADMIN_PASSWORD, min 12 chars) creates the owner's manager login
  // on the next seed run. Remove both from the environment afterwards.
  if (production) {
    const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? '';
    if (adminEmail && adminPassword) {
      if (adminPassword.length < 12) {
        throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
      }
      const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
      if (!existing) {
        const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'manager' } });
        await prisma.user.create({
          data: {
            name: process.env.SEED_ADMIN_NAME?.trim() || 'Owner',
            email: adminEmail,
            roleId: managerRole.id,
            passwordHash: await hashPassword(adminPassword),
            status: 'active',
          },
        });
        console.log(`Created initial manager account: ${adminEmail}`);
        console.log('IMPORTANT: remove SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from the environment now.');
      } else {
        console.log(`User ${adminEmail} already exists — not modified.`);
      }
    } else {
      console.log('No SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD set — no admin user created.');
    }
  }
}

/**
 * Phase 5 — company operations. Seeds the company-wide channel (the
 * singleton every active user sees) and two demo directory contacts.
 * In production both are skipped: the channel is created on demand by
 * POST /conversations, and contacts are added by staff.
 */
async function seedPhase5(production: boolean): Promise<void> {
  if (production) {
    console.log('Skipped (production): company-wide channel seed + demo directory contacts.');
    return;
  }
  const existing = await prisma.conversation.findFirst({ where: { kind: 'company_wide' } });
  const channel =
    existing ??
    (await prisma.conversation.create({
      data: {
        kind: 'company_wide',
        title: 'Company wide',
        createdById: (await prisma.user.findUnique({ where: { email: DEV_EMAIL } }))!.id,
      },
    }));

  const demoContacts = [
    {
      name: 'Demo Tow Partner',
      company: 'DEMO Tow Co.',
      role: 'Dispatch',
      phone: '(555) 010-4000',
      email: 'dispatch@example.com',
      notes: 'DEMO contact — safe to delete.',
    },
    {
      name: 'Demo Lot Manager',
      company: 'DEMO Storage Lots',
      role: 'Lot manager',
      phone: '(555) 010-4001',
      notes: 'DEMO contact — safe to delete.',
    },
  ];
  for (const c of demoContacts) {
    const hit = await prisma.directoryContact.findFirst({
      where: { name: c.name, company: c.company },
    });
    if (!hit) {
      await prisma.directoryContact.create({
        data: { ...c, addedById: channel.createdById },
      });
    }
  }

  console.log('Phase 5 seeded: company-wide channel + 2 demo directory contacts.');
}

/**
 * Phase 1 demo data — clearly-marked fixtures so the case lifecycle can be
 * exercised end to end. Everything here carries a DEMO marker in its name.
 */
async function seedPhase1Demo(): Promise<void> {
  const DEMO = ' — DEMO';

  const client = await prisma.client.upsert({
    where: { id: 'demo-client-1' },
    create: {
      id: 'demo-client-1',
      name: `Great Lakes Asset Recovery${DEMO}`,
      contactName: 'Demo Coordinator',
      contactPhone: '(555) 010-2030',
      contactEmail: 'coordinator@example.com',
      contactCell: '(555) 010-2031',
    },
    update: {},
  });

  const lender = await prisma.lender.upsert({
    where: { id: 'demo-lender-1' },
    create: { id: 'demo-lender-1', name: `Demo National Bank${DEMO}` },
    update: {},
  });

  const agentRole = await prisma.role.findUniqueOrThrow({ where: { name: 'agent' } });
  const demoAgent = await prisma.user.upsert({
    where: { email: 'agent.demo@repo-system.local' },
    create: {
      name: `Demo Agent${DEMO}`,
      email: 'agent.demo@repo-system.local',
      roleId: agentRole.id,
      passwordHash: await hashPassword('DemoAgent123!dev-only'),
      status: 'active',
    },
    update: {},
  });

  const debtor = await prisma.debtor.upsert({
    where: { id: 'demo-debtor-1' },
    create: {
      id: 'demo-debtor-1',
      name: `Jordan Demo Debtor${DEMO}`,
      personalPhone: '(555) 010-7788',
      homeAddress: '100 Demo Ranch Rd, Demo, TX 78000',
    },
    update: {},
  });

  const asset = await prisma.asset.upsert({
    where: { vin: '1D3M0000000000001' },
    create: {
      vin: '1D3M0000000000001',
      year: 2019,
      make: 'Demo Motors',
      model: 'DemoHauler 6000',
      color: 'White',
      plate: 'DEMO001',
      type: 'truck',
    },
    update: {},
  });

  // Walk the case through stages 1-6: intake -> assigned -> field_work ->
  // verify -> possession -> transport, with history for each move.
  const stages: Array<[string, string]> = [
    ['intake', 'Order received via email'],
    ['assigned', 'Assigned to demo agent'],
    ['field_work', 'Checking given addresses'],
    ['verify', 'Equipment located; running double-check'],
    ['possession', 'Physical possession taken'],
    ['transport', 'Agent transporting to lot'],
  ];
  const demoCase = await prisma.case.upsert({
    where: { caseNumber: 'CS-DEMO0001' },
    create: {
      id: 'demo-case-1',
      caseNumber: 'CS-DEMO0001',
      status: 'transport',
      priority: 'high',
      notes: 'Demo case — safe to delete.',
      source: 'email',
      clientId: client.id,
      lenderId: lender.id,
      debtorId: debtor.id,
      assetId: asset.id,
      assignedAgentId: demoAgent.id,
      addresses: {
        create: [
          { label: 'given', street: '100 Demo Ranch Rd', city: 'Demo', state: 'TX', zip: '78000' },
          { label: 'found', street: '44 Demo Industrial Pkwy', city: 'Demo', state: 'TX', zip: '78001' },
        ],
      },
    },
    update: {},
  });

  let from: string | null = null;
  const existingHistory = await prisma.caseStatusHistory.count({ where: { caseId: demoCase.id } });
  if (existingHistory === 0) {
    for (const [to, note] of stages) {
      await prisma.caseStatusHistory.create({
        data: { caseId: demoCase.id, from, to, actorId: null, note: `${note} (demo)` },
      });
      from = to;
    }
  }

  // Real Laredo, TX coordinates so the field map has something to pin.
  // Downtown Laredo (given address) and north Laredo industrial (found).
  await prisma.address.updateMany({
    where: { caseId: demoCase.id, label: 'given', lat: null },
    data: { lat: 27.5306, lng: -99.4861 },
  });
  await prisma.address.updateMany({
    where: { caseId: demoCase.id, label: 'found', lat: null },
    data: { lat: 27.5619, lng: -99.5067 },
  });

  const docKinds = [
    'post_recovery_photos',
    'condition_report',
    'delivery_sheet',
    'delivery_confirmation',
    'invoice',
  ];
  for (const kind of docKinds) {
    await prisma.requiredDocument.upsert({
      where: { caseId_kind: { caseId: demoCase.id, kind } },
      create: {
        caseId: demoCase.id,
        kind,
        status: kind === 'post_recovery_photos' ? 'submitted' : 'pending',
      },
      update: {},
    });
  }

  console.log('Phase 1 demo data seeded:');
  console.log('  client: Great Lakes Asset Recovery — DEMO');
  console.log('  case:   CS-DEMO0001 (transport stage, agent.demo@repo-system.local assigned)');
  console.log('  agent:  agent.demo@repo-system.local / DemoAgent123!dev-only  (DEV-ONLY)');
  console.log('');
}

/**
 * Phase 4 — research + client delivery. Seeds the three client-email
 * templates and a demo contact on the demo client.
 */
async function seedPhase4(production: boolean): Promise<void> {
  const templates = [
    {
      key: 'recovery_photos',
      name: 'Recovery photos',
      subject: 'Recovery photos — {{asset_year}} {{asset_make}} {{asset_model}} ({{case_number}})',
      body: [
        'Hello {{client_name}} team,',
        '',
        'The unit on {{case_number}} has been recovered. The post-recovery photos are attached:',
        '',
        '{{asset_year}} {{asset_make}} {{asset_model}} — {{asset_color}}',
        'VIN: {{asset_vin}}',
        '',
        'Debtor: {{debtor_name}}',
        '',
        'Please let us know if you need anything else.',
        '',
        '{{company_name}}',
      ].join('\n'),
    },
    {
      key: 'delivery_confirmation',
      name: 'Delivery confirmation',
      subject: 'Delivery confirmed — {{asset_year}} {{asset_make}} {{asset_model}} ({{case_number}})',
      body: [
        'Hello {{client_name}} team,',
        '',
        'The unit on {{case_number}} has been delivered:',
        '',
        '{{asset_year}} {{asset_make}} {{asset_model}} — {{asset_color}}',
        'VIN: {{asset_vin}}',
        '',
        'Signed for by: {{delivery_signed_by}}',
        'Delivered: {{delivery_date}}',
        '',
        'The signed delivery sheet is on file with the case.',
        '',
        '{{company_name}}',
      ].join('\n'),
    },
    {
      key: 'condition_report',
      name: 'Condition report',
      subject: 'Condition report — {{asset_year}} {{asset_make}} {{asset_model}} ({{case_number}})',
      body: [
        'Hello {{client_name}} team,',
        '',
        'The condition report for {{case_number}} is ready:',
        '',
        '{{asset_year}} {{asset_make}} {{asset_model}} — {{asset_color}}',
        'VIN: {{asset_vin}}',
        'Lender: {{lender_name}}',
        '',
        'The full report is attached. Delivery was confirmed before this report was sent.',
        '',
        '{{company_name}}',
      ].join('\n'),
    },
  ];
  for (const t of templates) {
    await prisma.emailTemplate.upsert({
      where: { key: t.key },
      create: t,
      update: { name: t.name, subject: t.subject, body: t.body },
    });
  }

  // Demo contact on the demo client so the email flow can be tried end to end.
  // Skipped in production (the demo client is never seeded there).
  if (production) {
    console.log('Phase 4 seeded: email templates (recovery_photos, delivery_confirmation, condition_report).');
    console.log('Skipped (production): demo client contact.');
    return;
  }
  const demoClient = await prisma.client.findUnique({ where: { id: 'demo-client-1' } });
  if (demoClient) {
    const existing = await prisma.clientContact.findFirst({
      where: { clientId: demoClient.id, email: 'coordinator@example.com' },
    });
    if (!existing) {
      await prisma.clientContact.create({
        data: {
          clientId: demoClient.id,
          name: 'Demo Coordinator',
          role: 'Account coordinator',
          phone: '(555) 010-2030',
          email: 'coordinator@example.com',
          cell: '(555) 010-2031',
          notes: 'DEMO contact — safe to delete.',
        },
      });
    }
  }

  console.log('Phase 4 seeded: email templates (recovery_photos, delivery_confirmation, condition_report) + demo client contact.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
