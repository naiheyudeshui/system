package com.example.todo.web;

/**
 * 创建任务时的请求体，对应 JSON：{"title":"买牛奶"}
 */
public class CreateTodoRequest {

    private String title;

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }
}
