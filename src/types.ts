export type Host = 'agents' | 'github';
export type ChangeState = 'open' | 'verified';
export interface TaskSummary {
  total: number;
  open: number;
  verified: number;
  invalid: number;
}
export interface Manifest {
  schemaVersion: 1;
  generatedBy: 'gdd';
  generatorVersion: string;
  hosts: Host[];
  managedPaths: string[];
  createdAt: string;
  updatedAt: string;
}
export interface ChangeRecord {
  path: string;
  id: string;
  title: string;
  state: ChangeState;
  updated: string;
  parent?: string;
  next: string;
  tasks: TaskSummary;
}
export interface TaskRecord {
  path: string;
  id: string;
  title: string;
  state: ChangeState;
  updated: string;
  dependsOn: string[];
  next: string;
}
