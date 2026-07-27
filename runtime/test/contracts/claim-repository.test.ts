import { InMemoryClaimRepository } from '../../src/context/public.js';
import { claimRepositoryConformance } from './claim-repository-conformance.js';

claimRepositoryConformance('in-memory', () => new InMemoryClaimRepository());
