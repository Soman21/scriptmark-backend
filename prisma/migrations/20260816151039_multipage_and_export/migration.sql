-- AlterTable
ALTER TABLE "MarkingGuide" ADD COLUMN     "isDraft" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MarkingSession" ADD COLUMN     "department" TEXT,
ADD COLUMN     "faculty" TEXT;

-- AlterTable
ALTER TABLE "Script" ADD COLUMN     "caScore" DOUBLE PRECISION,
ADD COLUMN     "regNumber" TEXT,
ADD COLUMN     "studentName" TEXT;

-- CreateTable
CREATE TABLE "ScriptPage" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "ocrText" TEXT,
    "ocrConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptPage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ScriptPage" ADD CONSTRAINT "ScriptPage_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
