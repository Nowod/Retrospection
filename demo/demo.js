document.getElementById("work-form").addEventListener("submit", event => {
  event.preventDefault();
  document.getElementById("form-result").textContent = "本次输入已完成。清空输入框后，即可查看它的独立历史。";
});
document.getElementById("search-form").addEventListener("submit", event => {
  event.preventDefault();
});
