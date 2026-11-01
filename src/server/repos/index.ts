import type { SqlDatabase } from "../db/database";
import { AgentsRepo } from "./agents";
import { CategoriesRepo } from "./categories";
import { ContentRepo } from "./content";
import { JobsRepo } from "./jobs";
import { ActivityRepo } from "./activity";

export interface Repos {
  agents: AgentsRepo;
  categories: CategoriesRepo;
  content: ContentRepo;
  jobs: JobsRepo;
  activity: ActivityRepo;
}

export function createRepos(db: SqlDatabase): Repos {
  return {
    agents: new AgentsRepo(db),
    categories: new CategoriesRepo(db),
    content: new ContentRepo(db),
    jobs: new JobsRepo(db),
    activity: new ActivityRepo(db),
  };
}
