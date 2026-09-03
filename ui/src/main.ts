import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

const target = document.getElementById("app");
if (!(target instanceof HTMLElement)) {
  throw new Error("Svelte mount target #app is missing");
}

mount(App, { target });
