import {
  digestCommit,
  identityFlows,
  renderContent,
  type DigestOptions,
  type GitTrailsDigest,
  type IdentityFlow
} from "git-trails";

const options: DigestOptions = { commit: "HEAD" };
const digest: GitTrailsDigest = digestCommit(options);
const rendered: string = renderContent(digest);
const flows: IdentityFlow[] = identityFlows(digest);

void rendered;
void flows;
