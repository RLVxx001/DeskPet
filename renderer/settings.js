const api = window.deskPet
const baseUrl = document.getElementById('baseUrl')
const model = document.getElementById('model')
const apiKey = document.getElementById('apiKey')
const embeddingBaseUrl = document.getElementById('embeddingBaseUrl')
const embeddingModel = document.getElementById('embeddingModel')
const embeddingApiKey = document.getElementById('embeddingApiKey')
const modelName = document.getElementById('modelName')
const knowledgePath = document.getElementById('knowledgePath')

const fill = (settings) => {
  baseUrl.value = settings.baseUrl || ''
  model.value = settings.model || ''
  apiKey.placeholder = settings.apiKey ? '已保存，留空不修改' : '不填就先用本地短回复'
  embeddingBaseUrl.value = settings.embeddingBaseUrl || ''
  embeddingModel.value = settings.embeddingModel || ''
  embeddingApiKey.placeholder = settings.embeddingApiKey ? '已保存，留空不修改' : '知识库向量检索用'
  modelName.textContent = settings.modelName || '默认角色'
  knowledgePath.textContent = settings.knowledgePath || '默认'
}

api.getSettings().then(fill)

document.getElementById('save').addEventListener('click', async () => {
  await api.saveSettings({
    baseUrl: baseUrl.value,
    model: model.value,
    apiKey: apiKey.value,
    embeddingBaseUrl: embeddingBaseUrl.value,
    embeddingModel: embeddingModel.value,
    embeddingApiKey: embeddingApiKey.value
  })
  api.closeSettings()
})

document.getElementById('pickModel').addEventListener('click', async () => {
  const name = await api.pickModel()
  modelName.textContent = name || modelName.textContent
})

document.getElementById('resetModel').addEventListener('click', async () => {
  const name = await api.resetModel()
  modelName.textContent = name || '默认角色'
})

document.getElementById('pickKnowledge').addEventListener('click', async () => {
  const info = await api.pickKnowledge()
  knowledgePath.textContent = info?.path || knowledgePath.textContent
})

document.getElementById('openKnowledge').addEventListener('click', () => {
  api.openKnowledge()
})

document.getElementById('close').addEventListener('click', () => api.closeSettings())
