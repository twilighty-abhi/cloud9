// All dev fixtures in one module. Only ever loaded through lib/fixtures.ts, by a dynamic
// import that exists in `vite` dev only, so production builds contain none of this (#14).
export * from './playerFixtures';
export * from './modFixtures';
export * from './presentFixtures';
