-- AlterTable
ALTER TABLE "MarkingSession" ADD COLUMN     "academicSession" TEXT,
ADD COLUMN     "autoAcceptHighConfidence" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "courseCode" TEXT,
ADD COLUMN     "examinationType" TEXT,
ADD COLUMN     "semester" TEXT;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "assignedMarkerId" TEXT;

-- AlterTable
ALTER TABLE "ScriptAnswer" ADD COLUMN     "autoAccepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "changeReason" TEXT,
ADD COLUMN     "changedAt" TIMESTAMP(3),
ADD COLUMN     "changedById" TEXT,
ADD COLUMN     "previousScore" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "SessionMarker" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionMarker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionMarker_sessionId_userId_key" ON "SessionMarker"("sessionId", "userId");

-- AddForeignKey
ALTER TABLE "SessionMarker" ADD CONSTRAINT "SessionMarker_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MarkingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionMarker" ADD CONSTRAINT "SessionMarker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_assignedMarkerId_fkey" FOREIGN KEY ("assignedMarkerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptAnswer" ADD CONSTRAINT "ScriptAnswer_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
