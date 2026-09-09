-- AlterTable
ALTER TABLE "Script" ADD COLUMN     "hasLowConfidenceScore" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ScriptAnswer" ADD COLUMN     "confidence" TEXT;
