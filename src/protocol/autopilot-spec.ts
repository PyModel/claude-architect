import type { DelegationSpec } from "./delegation-spec.js";

export interface AutopilotTaskSpec {
  id: string;
  commitMessage: string;
  delegation: DelegationSpec;
}

export interface AutopilotSpec {
  specVersion: "2";
  topic: string;
  base: { remote: "origin"; branch: "main" };
  tasks: AutopilotTaskSpec[];
  finalSuccessCriteria: string[];
  finalVerification: DelegationSpec["verification"];
}
