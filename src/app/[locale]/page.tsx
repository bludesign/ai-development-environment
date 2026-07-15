import Readme from "../../../README.md";

export default function Home() {
  return (
    <article className="prose prose-neutral dark:prose-invert mx-auto w-full max-w-4xl">
      <Readme />
    </article>
  );
}
