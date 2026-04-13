const lessonPacks = [
  {
    id: "sr-test-pack",
    title: "SR Test Pack",
    description: "Very short drills to validate spaced repetition and grading.",
    lessons: [
      {
        id: "sr-1",
        title: "SR Test 1",
        baseTempo: 56,
        sourceType: "json-notes",
        steps: [
          { degree: 0, fingering: 1 },
          { degree: 2, fingering: 2 },
          { degree: 4, fingering: 3 },
          { degree: 2, fingering: 2 },
        ],
      },
      {
        id: "sr-2",
        title: "SR Test 2",
        baseTempo: 60,
        sourceType: "json-notes",
        steps: [
          { degree: 1, fingering: 1 },
          { degree: 3, fingering: 2 },
          { degree: 5, fingering: 4 },
          { degree: 3, fingering: 2 },
        ],
      },
      {
        id: "sr-3",
        title: "SR Test 3",
        baseTempo: 64,
        sourceType: "json-notes",
        steps: [
          { degree: 0, fingering: 1 },
          { degree: 1, fingering: 2 },
          { degree: 2, fingering: 3 },
          { degree: 3, fingering: 4 },
        ],
      },
    ],
  },
  {
    id: "hanon-pack-1",
    title: "Hanon Pack 1",
    description: "Warmup patterns for evenness and control.",
    lessons: [
      {
        id: "hanon-1",
        title: "Lesson 1",
        tempo: 60,
        degrees: [0, 2, 3, 4, 5, 4, 3, 2],
        fingerings: [1, 2, 3, 4, 5, 4, 3, 2],
      },
      {
        id: "hanon-2",
        title: "Lesson 2",
        tempo: 60,
        degrees: [0, 2, 5, 4, 3, 4, 3, 2],
        fingerings: [1, 2, 5, 4, 3, 4, 3, 2],
      },
      {
        id: "hanon-3",
        title: "Lesson 3",
        tempo: 60,
        degrees: [0, 2, 5, 4, 3, 2, 3, 4],
        fingerings: [1, 2, 5, 4, 3, 2, 3, 4],
      },
      {
        id: "hanon-4",
        title: "Lesson 4",
        tempo: 60,
        degrees: [0, 1, 0, 2, 5, 4, 3, 2],
        fingerings: [1, 2, 1, 2, 5, 4, 3, 2],
      },
      {
        id: "hanon-5",
        title: "Lesson 5",
        tempo: 60,
        degrees: [0, 5, 4, 5, 3, 4, 2, 3],
        fingerings: [1, 5, 4, 5, 3, 4, 2, 3],
      },
      {
        id: "hanon-6",
        title: "Lesson 6",
        tempo: 60,
        degrees: [0, 5, 4, 5, 3, 5, 2, 5],
        fingerings: [1, 5, 4, 5, 3, 5, 2, 5],
      },
      {
        id: "hanon-7",
        title: "Lesson 7",
        tempo: 60,
        degrees: [0, 2, 1, 3, 2, 4, 3, 2],
        fingerings: [1, 3, 2, 4, 3, 5, 4, 3],
      },
      {
        id: "hanon-8",
        title: "Lesson 8",
        tempo: 60,
        degrees: [0, 2, 4, 5, 3, 4, 2, 3],
        fingerings: [1, 2, 4, 5, 3, 4, 2, 3],
      },
    ],
  },
];

const getPackById = (packId) => lessonPacks.find((pack) => pack.id === packId);
const getDefaultPackId = () => lessonPacks[0]?.id || null;

export { lessonPacks, getPackById, getDefaultPackId };