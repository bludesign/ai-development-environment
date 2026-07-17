declare module "jira2md" {
  const jira2md: {
    to_markdown(value: string): string;
    to_jira(value: string): string;
  };

  export default jira2md;
}
