import { useData, useRoute } from 'vitepress'
import giscusTalk from 'vitepress-plugin-comment-with-giscus'
import theme from 'vitepress/theme'

// 在 giscus.app 绑定仓库并取得 repoId/categoryId 后填入；留空时不渲染评论区，
// 避免新仓库在讨论区尚未创建时出现错误组件
const giscus = {
  repo: 'liuli-moe/persephone-s-waltz',
  repoId: '',
  categoryId: '',
}

export default {
  extends: theme,
  setup(): void {
    if (!giscus.repoId || !giscus.categoryId) {
      return
    }
    const { frontmatter } = useData()
    const route = useRoute()

    giscusTalk(
      {
        repo: giscus.repo,
        repoId: giscus.repoId,
        category: 'General',
        categoryId: giscus.categoryId,
        mapping: 'pathname',
        inputPosition: 'bottom',
        lang: 'zh-CN',
      },
      { frontmatter, route },
      true,
    )
  },
}
