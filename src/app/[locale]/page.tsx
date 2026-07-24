import Readme from "../../../README.md";

export default function Home() {
  return (
    <article className="prose prose-neutral dark:prose-invert w-full max-w-none">
      <Readme />
    </article>
  );
}
