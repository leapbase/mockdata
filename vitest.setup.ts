import { configure } from "@testing-library/dom";

// findBy* / waitFor give up after 1 s by default, which is too tight when other test files are loading the CPU.
configure({ asyncUtilTimeout: 5000 });
