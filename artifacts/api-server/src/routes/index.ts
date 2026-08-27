import { Router, type IRouter } from "express";
import healthRouter from "./health";
import cutroomRouter from "./cutroom";

const router: IRouter = Router();

router.use(healthRouter);
router.use(cutroomRouter);

export default router;
