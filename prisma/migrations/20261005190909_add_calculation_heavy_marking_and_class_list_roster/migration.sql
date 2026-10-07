-- AlterTable
ALTER TABLE "MarkingSession" ADD COLUMN     "classList" JSONB,
ADD COLUMN     "classListUploads" JSONB;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "isCalculationHeavy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "steps" JSONB;

-- AlterTable
ALTER TABLE "Script" ADD COLUMN     "classListEntryId" TEXT;

-- AlterTable
ALTER TABLE "ScriptAnswer" ADD COLUMN     "stepBreakdown" JSONB,
ADD COLUMN     "visionTranscript" TEXT;
