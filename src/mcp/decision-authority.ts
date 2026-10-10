/**
 * The decision-authority setting lives with the rest of the acceptance rules in
 * the runtime Candidate Decisions module; this re-export keeps MCP-layer
 * imports working.
 */
export {
  DECISION_AUTHORITY_ENV,
  decisionAuthority,
  type DecisionAuthority,
} from "../runtime/candidate-decisions.js";
