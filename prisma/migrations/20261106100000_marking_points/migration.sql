-- Marking points: quarter marks (1.25) need a decimal column, the guide's
-- printed question total is kept for checking, and drawn answers keep the
-- vision model's description of the diagram.
ALTER TABLE "Question" ALTER COLUMN "maxMarks" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "Question" ADD COLUMN "questionTotal" DOUBLE PRECISION;
ALTER TABLE "ScriptAnswer" ADD COLUMN "diagramDescription" TEXT;
