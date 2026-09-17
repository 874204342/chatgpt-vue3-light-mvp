<script lang="ts" setup>
// SaaS 接入已停用，导航区仅保留当前业务数据来源提示，避免继续暴露登录入口。
</script>


<style lang="scss" scoped>
.user-entry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  margin-left: 10px;
  padding: 0 14px 0 6px;
  border: 1px solid rgb(155 176 255 / 16%);
  border-radius: 999px;
  background: linear-gradient(180deg, rgb(255 255 255 / 72%), rgb(248 250 255 / 66%));
  box-shadow:
    0 10px 22px rgb(55 73 124 / 5%),
    inset 0 1px 0 rgb(255 255 255 / 75%);
  color: #556987;
  cursor: default;
}

.user-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.user-state {
  font-size: 13px;
  font-weight: 600;
}

.user-subtitle {
  color: #94a2b8;
  font-size: 11px;
  line-height: 1;
}
</style>
