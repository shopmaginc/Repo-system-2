-- ALPR — license plate reader subsystem: plate watch lists synced to field
-- phones and hit reports uploaded back.
--
-- NOTE: hand-written (no PostgreSQL/shadow database available in this
-- environment). Validate against a real Postgres (`prisma migrate dev`)
-- before production use.

-- CreateTable
CREATE TABLE "PlateList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlateList_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlateList_name_idx" ON "PlateList"("name");

-- CreateTable
CREATE TABLE "PlateEntry" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "state" TEXT,
    "notes" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlateEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlateEntry_listId_plate_key" ON "PlateEntry"("listId", "plate");

-- CreateIndex
CREATE INDEX "PlateEntry_plate_idx" ON "PlateEntry"("plate");

-- CreateTable
CREATE TABLE "PlateHit" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "state" TEXT,
    "confidence" DOUBLE PRECISION,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "photoRef" TEXT,
    "deviceId" TEXT,
    "listId" TEXT,
    "reportedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlateHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlateHit_plate_idx" ON "PlateHit"("plate");

-- CreateIndex
CREATE INDEX "PlateHit_createdAt_idx" ON "PlateHit"("createdAt");

-- AddForeignKey
ALTER TABLE "PlateList" ADD CONSTRAINT "PlateList_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateEntry" ADD CONSTRAINT "PlateEntry_listId_fkey" FOREIGN KEY ("listId") REFERENCES "PlateList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateHit" ADD CONSTRAINT "PlateHit_listId_fkey" FOREIGN KEY ("listId") REFERENCES "PlateList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateHit" ADD CONSTRAINT "PlateHit_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
