// wrangler 的 Text 規則把 .html 當字串打包（見 wrangler.jsonc rules）
declare module "*.html" {
  const content: string;
  export default content;
}
