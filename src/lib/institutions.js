// Institutions, faculties and departments. The list lives here, in code,
// and is copied into the database at start up (syncInstitutions), so a
// renamed or new department is a one line change with no migration.
// Rows are only added, never deleted, because lecturers point at them.
export const DEFAULT_INSTITUTION_ID = 'nau'

export const INSTITUTIONS = [
  {
    id: DEFAULT_INSTITUTION_ID,
    name: 'Nnamdi Azikiwe University',
    code: 'NAU',
    faculties: {
      Agriculture: [
        'Agricultural Economics and Extension',
        'Animal Science and Technology',
        'Crop Science and Horticulture',
        'Fisheries and Aquaculture',
        'Food Science and Technology',
        'Forestry and Wildlife Management',
        'Soil Science and Land Resources Management',
      ],
      Arts: [
        'Chinese Studies',
        'English Language and Literature',
        'History and International Studies',
        'Igbo, African and Asian Studies',
        'Linguistics',
        'Modern European Languages',
        'Music',
        'Philosophy',
        'Religion and Human Relations',
        'Theatre and Film Studies',
      ],
      'Basic Clinical Sciences': [
        'Chemical Pathology',
        'Haematology',
        'Medical Microbiology and Parasitology',
        'Pathology',
        'Pharmacology and Therapeutics',
      ],
      'Basic Medical Sciences': ['Anatomy', 'Human Biochemistry', 'Human Physiology'],
      Biosciences: [
        'Applied Biochemistry',
        'Applied Microbiology and Brewing',
        'Botany',
        'Parasitology and Entomology',
        'Zoology',
      ],
      Education: [
        'Adult and Continuing Education',
        'Early Childhood and Primary Education',
        'Educational Foundations',
        'Educational Management and Policy',
        'Guidance and Counselling',
        'Human Kinetics and Health Education',
        'Library and Information Science',
        'Science Education',
        'Technology and Vocational Education',
      ],
      Engineering: [
        'Agricultural and Bioresources Engineering',
        'Biomedical Engineering',
        'Chemical Engineering',
        'Civil Engineering',
        'Computer Engineering',
        'Electrical Engineering',
        'Electronics Engineering',
        'Industrial and Production Engineering',
        'Information and Communication Engineering',
        'Mechanical Engineering',
        'Metallurgical and Materials Engineering',
        'Petroleum Engineering',
        'Polymer and Textile Engineering',
        'Production Technology',
        'Telecommunication Engineering',
      ],
      'Environmental Sciences': [
        'Architecture',
        'Building',
        'Environmental Management',
        'Estate Management',
        'Fine and Applied Arts',
        'Geography and Meteorology',
        'Quantity Surveying',
        'Surveying and Geoinformatics',
      ],
      'Health Sciences and Technology': [
        'Environmental Health Science',
        'Human Nutrition and Dietetics',
        'Medical Laboratory Science',
        'Medical Rehabilitation',
        'Nursing Science',
        'Radiography',
      ],
      Law: ['Law'],
      'Management Sciences': [
        'Accountancy',
        'Banking and Finance',
        'Business Administration',
        'Cooperative Economics and Management',
        'Entrepreneurship Studies',
        'Marketing',
        'Public Administration',
      ],
      Medicine: [
        'Anaesthesiology',
        'Community Medicine',
        'Internal Medicine',
        'Mental Health',
        'Obstetrics and Gynaecology',
        'Ophthalmology',
        'Paediatrics',
        'Radiology',
        'Surgery',
      ],
      'Pharmaceutical Sciences': [
        'Clinical Pharmacy and Pharmacy Management',
        'Forensic Science',
        'Pharmaceutical and Medicinal Chemistry',
        'Pharmaceutical Microbiology and Biotechnology',
        'Pharmaceutics and Pharmaceutical Technology',
        'Pharmacognosy and Traditional Medicine',
        'Pharmacology and Toxicology',
      ],
      'Physical Sciences': [
        'Computer Science',
        'Cyber Security',
        'Geological Sciences',
        'Geophysics',
        'Information Technology',
        'Mathematics',
        'Physics and Industrial Physics',
        'Pure and Industrial Chemistry',
        'Software Engineering',
        'Statistics',
      ],
      'Social Sciences': ['Economics', 'Mass Communication', 'Political Science', 'Psychology', 'Sociology and Anthropology'],
    },
  },
]

// Copies the list above into the database. Safe to run any number of times.
export async function syncInstitutions(prisma) {
  try {
    for (const inst of INSTITUTIONS) {
      await prisma.institution.upsert({
        where: { id: inst.id },
        update: { name: inst.name },
        create: { id: inst.id, name: inst.name, code: inst.code },
      })
      for (const [facultyName, departments] of Object.entries(inst.faculties)) {
        const faculty = await prisma.faculty.upsert({
          where: { institutionId_name: { institutionId: inst.id, name: facultyName } },
          update: {},
          create: { institutionId: inst.id, name: facultyName },
        })
        for (const name of departments) {
          await prisma.department.upsert({
            where: { facultyId_name: { facultyId: faculty.id, name } },
            update: {},
            create: { facultyId: faculty.id, name },
          })
        }
      }
    }
  } catch (err) {
    console.error('Syncing institutions failed:', err)
  }
}

export const formatLecturerId = (code, n) => `${code}${String(n).padStart(4, '0')}`

// Gives a user the next ID of their institution, like NAU0042. The counter
// is bumped and read in one UPDATE, so two sign ups at the same moment can
// never get the same number.
export async function assignLecturerId(db, userId, institutionId = DEFAULT_INSTITUTION_ID) {
  const rows = await db.$queryRaw`
    UPDATE "Institution" SET "nextNumber" = "nextNumber" + 1
    WHERE id = ${institutionId}
    RETURNING code, "nextNumber" - 1 AS n`
  if (!rows.length) return null
  const lecturerId = formatLecturerId(rows[0].code, Number(rows[0].n))
  await db.user.update({ where: { id: userId }, data: { lecturerId, institutionId } })
  return lecturerId
}
